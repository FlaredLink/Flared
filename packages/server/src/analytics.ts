// SPDX-License-Identifier: AGPL-3.0-only
// The click Queue consumer and the analytics reads. Both resolve the tenant's assigned shard.
import type { D1Database } from '@cloudflare/workers-types/index.ts';
import {
	clickEventMaxAgeMs,
	clickEventMaxSkewMs,
	dayPattern,
	oldestRetainedDay,
	parseClickEvent,
	utcDay,
	usageWarnings,
	utcMonth,
	type ClickEvent,
	type DimensionClicks,
	type LinkAnalytics,
	type Usage
} from '@flared/contracts/analytics';
import {
	exportAnalyticsPageSize,
	exportDimensions,
	type ExportDimensionsPage,
	type ExportTotalsPage
} from '@flared/contracts/export';
import {
	ingestClick,
	readDailyTotals,
	readExportDimensions,
	readExportTotals,
	readDimensions,
	readLinkClickTotals,
	readMonthlyUsage,
	readShardPolicy,
	recordIngestionMinutes,
	type IngestionMinute,
	type ShardPolicy
} from '@flared/data/analytics';
import { isTombstoned } from '@flared/data/deletions';
import { readLimitUsage } from '@flared/data/routing-policy';
import { readTenantShard } from '@flared/data/tenancy';
import { ApiError } from './links';
import { resolveShard, UnknownShardError, type AnalyticsShards } from './shards';

// The parts of a Queue message and batch that the consumer uses.
export interface QueueMessage {
	readonly body: unknown;
	ack(): void;
	retry(options?: { delaySeconds?: number }): void;
}

export interface QueueBatch {
	readonly messages: readonly QueueMessage[];
}

export interface ClickConsumerDependencies {
	shards: AnalyticsShards;
	now?: () => number;
	// Delay before a retry when the shard does not hold the tenant's policy yet.
	policyRetryDelaySeconds?: number;
	// A single-workspace installation's tenant. An event of any other tenant is dropped.
	fixedTenantId?: string;
}

export type ConsumeResult = 'admitted' | 'skipped' | 'duplicate' | 'dropped' | 'retry';

// Acknowledges a message only after its batch has committed. An event that can never count is
// dropped; anything that may succeed later is retried, and the Queue moves it to the
// dead-letter queue after the retry limit. No event falls back to another shard.
export function createClickConsumer(dependencies: ClickConsumerDependencies) {
	const now = dependencies.now ?? Date.now;
	const policyRetryDelaySeconds = dependencies.policyRetryDelaySeconds ?? 60;

	function drop(message: QueueMessage, reason: string): ConsumeResult {
		console.error(JSON.stringify({ event: 'click_event_dropped', reason }));
		message.ack();
		return 'dropped';
	}

	async function consumeOne(
		message: QueueMessage,
		event: ClickEvent | null,
		time: number
	): Promise<ConsumeResult> {
		if (!event) return drop(message, 'invalid');
		// Synthetic checks arrive with their own plan; until then a test event is never counted.
		if (event.kind !== 'production') return drop(message, 'unsupported_kind');
		if (dependencies.fixedTenantId !== undefined && event.tenantId !== dependencies.fixedTenantId)
			return drop(message, 'foreign_tenant');
		if (event.occurredAt < time - clickEventMaxAgeMs) return drop(message, 'expired');
		if (event.occurredAt > time + clickEventMaxSkewMs) return drop(message, 'future');
		try {
			const db = resolveShard(dependencies.shards, event.analyticsShardId);
			const outcome = await ingestClick(
				db,
				{
					tenantId: event.tenantId,
					eventId: event.eventId,
					linkId: event.linkId,
					day: utcDay(event.occurredAt),
					month: utcMonth(event.occurredAt),
					country: event.country,
					device: event.deviceCategory,
					referrer: event.referrerHostname
				},
				crypto.randomUUID(),
				time
			);
			if (outcome === 'no_policy') {
				// A deleted workspace never gets its policy back, so its late clicks are dropped.
				if (await isTombstoned(db, event.tenantId)) return drop(message, 'deleted_tenant');
				console.error(JSON.stringify({ event: 'click_policy_missing', tenantId: event.tenantId }));
				message.retry({ delaySeconds: policyRetryDelaySeconds });
				return 'retry';
			}
			message.ack();
			return outcome;
		} catch (error) {
			const reason = error instanceof UnknownShardError ? 'unknown_shard' : 'ingest_failed';
			console.error(JSON.stringify({ event: 'click_ingest_retry', reason }));
			message.retry();
			return 'retry';
		}
	}

	// Counts each event against the shard it names. An invalid event names no shard and an
	// unbound shard has nowhere to keep counts, so only the log shows those.
	return async function consume(batch: QueueBatch): Promise<ConsumeResult[]> {
		const results: ConsumeResult[] = [];
		const minutes = new Map<string, Map<number, IngestionMinute>>();
		for (const message of batch.messages) {
			const time = now();
			const event = parseClickEvent(message.body);
			const result = await consumeOne(message, event, time);
			results.push(result);
			if (!event) continue;
			const minute = Math.floor(time / 60000) * 60000;
			const shard = minutes.get(event.analyticsShardId) ?? new Map<number, IngestionMinute>();
			minutes.set(event.analyticsShardId, shard);
			const row = shard.get(minute) ?? {
				minute,
				counted: 0,
				duplicates: 0,
				dropped: 0,
				retried: 0,
				maxLagMs: 0,
				lastOccurredAt: null
			};
			shard.set(minute, row);
			if (result === 'admitted' || result === 'skipped') {
				row.counted += 1;
				row.maxLagMs = Math.max(row.maxLagMs, time - event.occurredAt);
				row.lastOccurredAt = Math.max(row.lastOccurredAt ?? 0, event.occurredAt);
			} else if (result === 'duplicate') row.duplicates += 1;
			else if (result === 'dropped') row.dropped += 1;
			else row.retried += 1;
		}
		for (const [shardId, shard] of minutes) {
			try {
				const db = resolveShard(dependencies.shards, shardId);
				await recordIngestionMinutes(db, [...shard.values()]);
			} catch {
				console.error(JSON.stringify({ event: 'ingestion_stats_failed', shardId }));
			}
		}
		return results;
	};
}

export class AnalyticsRangeError extends Error {}

export class AnalyticsUnavailableError extends Error {
	constructor() {
		super('Analytics are not available');
	}
}

function validDay(value: string): boolean {
	return dayPattern.test(value) && utcDay(Date.parse(`${value}T00:00:00Z`) || 0) === value;
}

// Both ends are inclusive UTC days. Without input the range is the last 30 days. Days before the
// retention window or after today are cut off, because they cannot hold data.
export function parseRange(
	input: { from?: string; to?: string },
	now: number,
	retentionDays: number
): { from: string; to: string } {
	for (const value of [input.from, input.to])
		if (value !== undefined && !validDay(value))
			throw new AnalyticsRangeError('Use dates in the form YYYY-MM-DD.');
	const today = utcDay(now);
	const oldest = oldestRetainedDay(now, retentionDays);
	let to = input.to ?? today;
	let from = input.from ?? oldestRetainedDay(Date.parse(`${to}T00:00:00Z`), 30);
	if (from > to) throw new AnalyticsRangeError('Use a start date on or before the end date.');
	if (to > today) to = today;
	if (from < oldest) from = oldest;
	if (from > to) from = to;
	return { from, to };
}

function daysBetween(from: string, to: string): string[] {
	const days: string[] = [];
	for (
		let time = Date.parse(`${from}T00:00:00Z`);
		utcDay(time) <= to && days.length < 400;
		time += 86400000
	)
		days.push(utcDay(time));
	return days;
}

async function tenantShard(
	identity: D1Database,
	shards: AnalyticsShards,
	tenantId: string
): Promise<{ db: D1Database; policy: ShardPolicy }> {
	const shardId = await readTenantShard(identity, tenantId);
	if (!shardId) throw new AnalyticsUnavailableError();
	let db: D1Database;
	try {
		db = resolveShard(shards, shardId);
	} catch {
		throw new AnalyticsUnavailableError();
	}
	const policy = await readShardPolicy(db, tenantId);
	if (!policy) throw new AnalyticsUnavailableError();
	return { db, policy };
}

// The caller has already checked that the tenant owns the link.
export async function getLinkAnalytics(
	identity: D1Database,
	shards: AnalyticsShards,
	tenantId: string,
	linkId: string,
	input: { from?: string; to?: string },
	now: number
): Promise<LinkAnalytics> {
	const { db, policy } = await tenantShard(identity, shards, tenantId);
	const { from, to } = parseRange(input, now, policy.retentionDays);
	const [totals, dimensions] = await Promise.all([
		readDailyTotals(db, tenantId, linkId, from, to),
		readDimensions(db, tenantId, linkId, from, to)
	]);
	const days = daysBetween(from, to).map((day) => ({ day, clicks: totals.get(day) ?? 0 }));
	const of = (name: string): DimensionClicks[] =>
		dimensions
			.filter((row) => row.dimension === name)
			.map(({ value, clicks }) => ({ value, clicks }));
	return {
		linkId,
		from,
		to,
		total: days.reduce((sum, day) => sum + day.clicks, 0),
		days,
		countries: of('country'),
		devices: of('device'),
		referrers: of('referrer'),
		asOf: new Date(now).toISOString()
	};
}

export async function getUsage(
	identity: D1Database,
	routing: D1Database,
	shards: AnalyticsShards,
	tenantId: string,
	now: number
): Promise<Usage> {
	const { db, policy } = await tenantShard(identity, shards, tenantId);
	const month = utcMonth(now);
	const [monthly, limits] = await Promise.all([
		readMonthlyUsage(db, tenantId, month),
		readLimitUsage(routing, tenantId)
	]);
	if (!limits) throw new AnalyticsUnavailableError();
	const counts = {
		clicks: monthly.clicks,
		clickLimit: policy.monthlyClickLimit,
		links: limits.links,
		domains: limits.domains
	};
	return {
		month,
		...counts,
		unrecordedClicks: monthly.skippedClicks,
		unrecordedSince:
			monthly.firstSkippedAt === null ? null : new Date(monthly.firstSkippedAt).toISOString(),
		retentionDays: policy.retentionDays,
		warnings: usageWarnings(counts),
		asOf: new Date(now).toISOString()
	};
}

// Clicks in the last 30 days for each link, or null when analytics cannot be read. A list of
// links stays available while analytics are not.
export async function getRecentClicks(
	identity: D1Database,
	shards: AnalyticsShards | undefined,
	tenantId: string,
	linkIds: string[],
	now: number
): Promise<Map<string, number> | null> {
	if (!shards) return null;
	try {
		const { db } = await tenantShard(identity, shards, tenantId);
		return await readLinkClickTotals(db, tenantId, linkIds, oldestRetainedDay(now, 30));
	} catch {
		console.error(JSON.stringify({ event: 'recent_clicks_unavailable' }));
		return null;
	}
}

// An export cursor is the last row's key as base64url JSON. The tenant always comes from the
// request, so a cursor cannot reach another workspace's rows.
function encodeExportCursor(key: string[]): string {
	let binary = '';
	for (const byte of new TextEncoder().encode(JSON.stringify(key)))
		binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeExportCursor(value: string, length: number): string[] {
	const invalid = () =>
		new ApiError('INVALID_INPUT', 'Use the nextCursor value from the previous page.');
	if (value.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(value)) throw invalid();
	let key: unknown;
	try {
		const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
		key = JSON.parse(
			new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
				Uint8Array.from(binary, (character) => character.charCodeAt(0))
			)
		);
	} catch {
		throw invalid();
	}
	if (
		!Array.isArray(key) ||
		key.length !== length ||
		!key.every((part) => typeof part === 'string' && part.length > 0 && part.length <= 512)
	)
		throw invalid();
	return key;
}

// One page of the tenant's retained daily totals for an export.
export async function getExportTotals(
	identity: D1Database,
	shards: AnalyticsShards,
	tenantId: string,
	cursor: string | null,
	now: number,
	limit = exportAnalyticsPageSize
): Promise<ExportTotalsPage> {
	const after = cursor ? decodeExportCursor(cursor, 2) : null;
	const { db, policy } = await tenantShard(identity, shards, tenantId);
	const from = oldestRetainedDay(now, policy.retentionDays);
	const rows = await readExportTotals(
		db,
		tenantId,
		from,
		after ? { linkId: after[0], day: after[1] } : null,
		limit + 1
	);
	const page = rows.slice(0, limit);
	const last = page.at(-1);
	return {
		from,
		retentionDays: policy.retentionDays,
		rows: page,
		nextCursor: rows.length > limit && last ? encodeExportCursor([last.linkId, last.day]) : null
	};
}

// One page of the tenant's retained daily breakdowns for an export.
export async function getExportDimensions(
	identity: D1Database,
	shards: AnalyticsShards,
	tenantId: string,
	cursor: string | null,
	now: number,
	limit = exportAnalyticsPageSize
): Promise<ExportDimensionsPage> {
	const after = cursor ? decodeExportCursor(cursor, 4) : null;
	const dimension = exportDimensions.find((name) => name === after?.[2]);
	if (after && !dimension)
		throw new ApiError('INVALID_INPUT', 'Use the nextCursor value from the previous page.');
	const { db, policy } = await tenantShard(identity, shards, tenantId);
	const from = oldestRetainedDay(now, policy.retentionDays);
	const rows = await readExportDimensions(
		db,
		tenantId,
		from,
		after && dimension ? { linkId: after[0], day: after[1], dimension, value: after[3] } : null,
		limit + 1
	);
	const page = rows.slice(0, limit);
	const last = page.at(-1);
	return {
		from,
		retentionDays: policy.retentionDays,
		rows: page,
		nextCursor:
			rows.length > limit && last
				? encodeExportCursor([last.linkId, last.day, last.dimension, last.value])
				: null
	};
}
