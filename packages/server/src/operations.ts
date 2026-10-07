// SPDX-License-Identifier: AGPL-3.0-only
// Operating the installation: analytics shard sizes and their growth, and click events that
// the Queue gave up on. Each edition chooses its own capacity thresholds.
import type { D1Database } from '@cloudflare/workers-types/index.ts';
import { clickEventMaxAgeMs, parseClickEvent } from '@flared/contracts/analytics';
import { readIngestionSummary, type IngestionSummary } from '@flared/data/analytics';
import {
	claimDeadLetter,
	countTenantsByShard,
	readShardSamplePairs,
	recordShardSample,
	releaseDeadLetter,
	storeDeadLetter,
	type ShardSample,
	type ShardSamplePair
} from '@flared/data/operations';
import type { QueueMessage } from './analytics';
import type { ClickSink } from './redirect';
import { resolveShard, type AnalyticsShards } from './shards';

// D1 returns the database size after each query, so a read needs no account credentials.
async function shardSize(db: D1Database): Promise<number> {
	const result = await db.prepare('SELECT 1').run();
	const size: unknown = result.meta.size_after;
	if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0)
		throw new Error('D1 returned no database size');
	return size;
}

export interface ShardMeasurement {
	shardId: string;
	sample: ShardSample | null;
}

// Records one size sample for each bound shard. A shard that cannot be read gets no sample and
// keeps its older ones; the caller shows the sample time.
export async function measureShards(
	identity: D1Database,
	shards: AnalyticsShards,
	now: number
): Promise<ShardMeasurement[]> {
	const tenants = await countTenantsByShard(identity);
	const measurements: ShardMeasurement[] = [];
	for (const shardId of Object.keys(shards).sort()) {
		try {
			const sample: ShardSample = {
				shardId,
				sampledAt: now,
				sizeBytes: await shardSize(resolveShard(shards, shardId)),
				tenants: tenants.get(shardId) ?? 0
			};
			await recordShardSample(identity, sample);
			measurements.push({ shardId, sample });
		} catch {
			console.error(JSON.stringify({ event: 'shard_measure_failed', shardId }));
			measurements.push({ shardId, sample: null });
		}
	}
	return measurements;
}

export interface ShardProjection {
	shardId: string;
	sizeBytes: number;
	tenants: number;
	sampledAt: number;
	// Bytes per day over the measured span; null until the samples span one day.
	growthPerDay: number | null;
	measuredDays: number;
	projectedBytes: number;
}

// The size after `horizonDays` more days at the average growth from the base sample to the
// latest. A shrinking shard projects its current size. Without one day of samples, the
// projection is the current size and growthPerDay is null.
export function projectShard(pair: ShardSamplePair, horizonDays: number): ShardProjection {
	const { latest, base } = pair;
	const spanMs = latest.sampledAt - base.sampledAt;
	const measuredDays = spanMs / 86400000;
	const growthPerDay =
		measuredDays >= 1 ? Math.max(0, (latest.sizeBytes - base.sizeBytes) / measuredDays) : null;
	return {
		shardId: latest.shardId,
		sizeBytes: latest.sizeBytes,
		tenants: latest.tenants,
		sampledAt: latest.sampledAt,
		growthPerDay,
		measuredDays,
		projectedBytes: Math.round(latest.sizeBytes + (growthPerDay ?? 0) * horizonDays)
	};
}

// Projections of the bound shards that have samples, from growth over `windowDays`.
export async function readShardProjections(
	identity: D1Database,
	shards: AnalyticsShards,
	now: number,
	options: { windowDays: number; horizonDays: number }
): Promise<ShardProjection[]> {
	const pairs = await readShardSamplePairs(
		identity,
		Object.keys(shards).sort(),
		now - options.windowDays * 86400000
	);
	return [...pairs.values()].map((pair) => projectShard(pair, options.horizonDays));
}

export interface ShardIngestion extends IngestionSummary {
	shardId: string;
}

// The click consumer's counts of each bound shard from `since` on. A shard that cannot be read
// is left out and logged.
export async function readIngestion(
	shards: AnalyticsShards,
	since: number
): Promise<ShardIngestion[]> {
	const summaries: ShardIngestion[] = [];
	for (const shardId of Object.keys(shards).sort()) {
		try {
			const summary = await readIngestionSummary(resolveShard(shards, shardId), since);
			summaries.push({ shardId, ...summary });
		} catch {
			console.error(JSON.stringify({ event: 'ingestion_read_failed', shardId }));
		}
	}
	return summaries;
}

export interface DeadLetterMessage extends QueueMessage {
	readonly id: string;
}

// Consumer of the click dead-letter queue. It stores each message for the operator and
// acknowledges it; only the validated event fields are kept.
export function createDeadLetterConsumer(dependencies: {
	identity: D1Database;
	now?: () => number;
}) {
	const now = dependencies.now ?? Date.now;
	return async function consume(batch: {
		readonly messages: readonly DeadLetterMessage[];
	}): Promise<void> {
		for (const message of batch.messages) {
			const event = parseClickEvent(message.body);
			try {
				await storeDeadLetter(dependencies.identity, {
					id: event ? `event:${event.eventId}` : `message:${message.id.slice(0, 128)}`,
					receivedAt: now(),
					shardId: event?.analyticsShardId ?? null,
					occurredAt: event?.occurredAt ?? null,
					event: event ? JSON.stringify(event) : null
				});
				console.error(
					JSON.stringify({ event: 'click_dead_letter', valid: event !== null, id: message.id })
				);
				message.ack();
			} catch {
				console.error(JSON.stringify({ event: 'dead_letter_store_failed', id: message.id }));
				message.retry();
			}
		}
	};
}

export type RequeueResult = 'requeued' | 'not_found' | 'expired' | 'failed';

// Sends a stored event to the click Queue again. Event deduplication keeps a click that was
// counted before from counting twice. The consumer refuses events past the replay horizon, so
// those are not sent.
export async function requeueDeadLetter(
	identity: D1Database,
	clicks: ClickSink,
	id: string,
	now: number
): Promise<RequeueResult> {
	const stored = await claimDeadLetter(identity, id, now);
	if (stored === null) return 'not_found';
	let body: unknown = null;
	try {
		body = JSON.parse(stored);
	} catch {
		body = null;
	}
	const event = parseClickEvent(body);
	if (!event || event.occurredAt < now - clickEventMaxAgeMs) {
		await releaseDeadLetter(identity, id, now);
		return event ? 'expired' : 'not_found';
	}
	try {
		await clicks.send(event);
		return 'requeued';
	} catch {
		await releaseDeadLetter(identity, id, now);
		console.error(JSON.stringify({ event: 'dead_letter_requeue_failed', id }));
		return 'failed';
	}
}
