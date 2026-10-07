// SPDX-License-Identifier: AGPL-3.0-only
// Identity-store records for operating the installation: analytics shard size samples and
// click events that the Queue gave up on.
import type { D1Database } from '@cloudflare/workers-types/index.ts';

export const shardSampleLifetimeMs = 90 * 86400000;
export const deadLetterLifetimeMs = 7 * 86400000;

function count(value: unknown, field: string): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
		throw new Error(`Invalid stored ${field}`);
	return value;
}

function text(value: unknown, field: string): string {
	if (typeof value !== 'string' || !value) throw new Error(`Invalid stored ${field}`);
	return value;
}

function optionalText(value: unknown, field: string): string | null {
	return value === null ? null : text(value, field);
}

function optionalCount(value: unknown, field: string): number | null {
	return value === null ? null : count(value, field);
}

// Workspaces assigned to each shard, deleting ones included: their rows stay until the
// deletion job removes them.
export async function countTenantsByShard(identity: D1Database): Promise<Map<string, number>> {
	const { results } = await identity
		.prepare(
			'SELECT analytics_shard_id AS shard_id, COUNT(*) AS tenants FROM tenants GROUP BY analytics_shard_id'
		)
		.all<Record<string, unknown>>();
	return new Map(
		results.map((row) => [text(row.shard_id, 'shard'), count(row.tenants, 'tenant count')])
	);
}

export interface ShardSample {
	shardId: string;
	sampledAt: number;
	sizeBytes: number;
	tenants: number;
}

export async function recordShardSample(identity: D1Database, sample: ShardSample): Promise<void> {
	await identity
		.prepare(
			'INSERT OR REPLACE INTO analytics_shard_samples (shard_id, sampled_at, size_bytes, tenants) VALUES (?, ?, ?, ?)'
		)
		.bind(sample.shardId, sample.sampledAt, sample.sizeBytes, sample.tenants)
		.run();
}

// The newest sample of the shard and the oldest one from `since` on, which measure its growth.
export interface ShardSamplePair {
	latest: ShardSample;
	base: ShardSample;
}

function sample(row: Record<string, unknown>): ShardSample {
	return {
		shardId: text(row.shard_id, 'shard'),
		sampledAt: count(row.sampled_at, 'sample time'),
		sizeBytes: count(row.size_bytes, 'size'),
		tenants: count(row.tenants, 'tenant count')
	};
}

export async function readShardSamplePairs(
	identity: D1Database,
	shardIds: readonly string[],
	since: number
): Promise<Map<string, ShardSamplePair>> {
	const pairs = new Map<string, ShardSamplePair>();
	if (shardIds.length === 0) return pairs;
	const columns = 'shard_id, sampled_at, size_bytes, tenants';
	const results = await identity.batch<Record<string, unknown>>(
		shardIds.flatMap((shardId) => [
			identity
				.prepare(
					`SELECT ${columns} FROM analytics_shard_samples WHERE shard_id = ? ORDER BY sampled_at DESC LIMIT 1`
				)
				.bind(shardId),
			identity
				.prepare(
					`SELECT ${columns} FROM analytics_shard_samples WHERE shard_id = ? AND sampled_at >= ? ORDER BY sampled_at ASC LIMIT 1`
				)
				.bind(shardId, since)
		])
	);
	shardIds.forEach((shardId, index) => {
		const latest = results[index * 2]?.results[0];
		const base = results[index * 2 + 1]?.results[0];
		if (latest) pairs.set(shardId, { latest: sample(latest), base: sample(base ?? latest) });
	});
	return pairs;
}

export interface NewDeadLetter {
	id: string;
	receivedAt: number;
	shardId: string | null;
	occurredAt: number | null;
	// The validated event as JSON, or null when the body was not a valid event.
	event: string | null;
}

// A redelivered dead letter keeps its first row.
export async function storeDeadLetter(identity: D1Database, letter: NewDeadLetter): Promise<void> {
	await identity
		.prepare(
			'INSERT OR IGNORE INTO dead_letters (id, received_at, shard_id, occurred_at, event) VALUES (?, ?, ?, ?, ?)'
		)
		.bind(letter.id, letter.receivedAt, letter.shardId, letter.occurredAt, letter.event)
		.run();
}

export interface DeadLetter {
	id: string;
	receivedAt: number;
	shardId: string | null;
	occurredAt: number | null;
	valid: boolean;
	requeuedAt: number | null;
}

export async function listDeadLetters(identity: D1Database, limit: number): Promise<DeadLetter[]> {
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
		throw new Error('Invalid dead letter page size');
	const { results } = await identity
		.prepare(
			'SELECT id, received_at, shard_id, occurred_at, event IS NOT NULL AS valid, requeued_at FROM dead_letters ORDER BY received_at DESC, id LIMIT ?'
		)
		.bind(limit)
		.all<Record<string, unknown>>();
	return results.map((row) => ({
		id: text(row.id, 'dead letter'),
		receivedAt: count(row.received_at, 'received time'),
		shardId: optionalText(row.shard_id, 'shard'),
		occurredAt: optionalCount(row.occurred_at, 'occurred time'),
		valid: row.valid === 1,
		requeuedAt: optionalCount(row.requeued_at, 'requeue time')
	}));
}

// All stored dead letters, and the valid ones not yet requeued that are still inside the
// replay horizon (occurred at or after `requeueableSince`).
export async function countDeadLetters(
	identity: D1Database,
	requeueableSince: number
): Promise<{ total: number; requeueable: number }> {
	const row = await identity
		.prepare(
			'SELECT COUNT(*) AS total, COALESCE(SUM(event IS NOT NULL AND requeued_at IS NULL AND occurred_at >= ?), 0) AS requeueable FROM dead_letters'
		)
		.bind(requeueableSince)
		.first<Record<string, unknown>>();
	return {
		total: count(row?.total, 'dead letter count'),
		requeueable: count(row?.requeueable, 'dead letter count')
	};
}

// Marks a valid dead letter as requeued and returns its event, or null when it does not exist,
// is not valid, or was requeued already. Two operators cannot requeue it at once.
export async function claimDeadLetter(
	identity: D1Database,
	id: string,
	now: number
): Promise<string | null> {
	const row = await identity
		.prepare(
			'UPDATE dead_letters SET requeued_at = ? WHERE id = ? AND requeued_at IS NULL AND event IS NOT NULL RETURNING event'
		)
		.bind(now, id)
		.first<Record<string, unknown>>();
	return row ? text(row.event, 'dead letter event') : null;
}

// Undoes a claim when the send failed, so the operator can try again.
export async function releaseDeadLetter(
	identity: D1Database,
	id: string,
	claimedAt: number
): Promise<void> {
	await identity
		.prepare('UPDATE dead_letters SET requeued_at = NULL WHERE id = ? AND requeued_at = ?')
		.bind(id, claimedAt)
		.run();
}

// Removes old samples and dead letters, at most `limit` rows of each per call.
export async function purgeOperations(
	identity: D1Database,
	now: number,
	limit: number
): Promise<{ deleted: number }> {
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000)
		throw new Error('Invalid purge batch size');
	const results = await identity.batch([
		identity
			.prepare(
				'DELETE FROM analytics_shard_samples WHERE (shard_id, sampled_at) IN (SELECT shard_id, sampled_at FROM analytics_shard_samples WHERE sampled_at < ? LIMIT ?)'
			)
			.bind(now - shardSampleLifetimeMs, limit),
		identity
			.prepare(
				'DELETE FROM dead_letters WHERE id IN (SELECT id FROM dead_letters WHERE received_at < ? LIMIT ?)'
			)
			.bind(now - deadLetterLifetimeMs, limit)
	]);
	return { deleted: results.reduce((sum, result) => sum + (result.meta.changes ?? 0), 0) };
}
