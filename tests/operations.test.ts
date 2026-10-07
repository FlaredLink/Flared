// SPDX-License-Identifier: AGPL-3.0-only
// Consumer counts per minute, shard size samples and projections, and dead letters.
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ClickEvent } from '../packages/contracts/src/analytics';
import {
	applyAnalyticsPolicy,
	purgeExpired,
	readIngestionSummary
} from '../packages/data/src/analytics';
import {
	countDeadLetters,
	listDeadLetters,
	purgeOperations
} from '../packages/data/src/operations';
import { createClickConsumer, type QueueMessage } from '../packages/server/src/analytics';
import {
	createDeadLetterConsumer,
	measureShards,
	projectShard,
	readShardProjections,
	requeueDeadLetter,
	type DeadLetterMessage
} from '../packages/server/src/operations';

const shard = () => env.OPERATIONS_ANALYTICS;
const identity = () => env.OPERATIONS_IDENTITY;
const shards = () => ({ 'analytics-1': shard() });
const day = 86400000;
const start = Date.UTC(2026, 9, 7, 12, 0, 30);
const minute = Date.UTC(2026, 9, 7, 12, 0);

beforeAll(async () => {
	await applyD1Migrations(shard(), env.ANALYTICS_MIGRATIONS, 'flared_core_migrations');
	await applyD1Migrations(identity(), env.IDENTITY_MIGRATIONS, 'flared_core_migrations');
	await identity()
		.prepare("INSERT INTO installation (id, mode, created_at) VALUES (1, 'multi', 0)")
		.run();
	await applyAnalyticsPolicy(shard(), {
		tenantId: 't-ops',
		revision: 1,
		monthlyClickLimit: 5000,
		retentionDays: 30,
		now: 0
	});
});

function event(change: Partial<ClickEvent> = {}): ClickEvent {
	return {
		schemaVersion: 1,
		eventId: crypto.randomUUID(),
		tenantId: 't-ops',
		analyticsShardId: 'analytics-1',
		linkId: 'link-1',
		kind: 'production',
		occurredAt: start - 30000,
		country: 'DE',
		deviceCategory: 'desktop',
		referrerHostname: 'unknown',
		...change
	};
}

function message(body: unknown, id: string = crypto.randomUUID()) {
	const state: { acked: boolean; retried: boolean } = { acked: false, retried: false };
	const value: DeadLetterMessage = {
		id,
		body,
		ack: () => {
			state.acked = true;
		},
		retry: () => {
			state.retried = true;
		}
	};
	return { value, state };
}

const consume = (
	bodies: unknown[],
	time = start,
	shardMap: Record<string, D1Database> = shards()
) =>
	createClickConsumer({ shards: shardMap, now: () => time })({
		messages: bodies.map((body): QueueMessage => message(body).value)
	});

const minuteRow = (at: number) =>
	shard()
		.prepare(
			'SELECT counted, duplicates, dropped, retried, max_lag_ms, last_occurred_at FROM ingestion_minutes WHERE minute = ?'
		)
		.bind(at)
		.first();

const usage = () =>
	shard()
		.prepare("SELECT clicks FROM monthly_usage WHERE tenant_id = 't-ops' AND month = '2026-10'")
		.first<{ clicks: number }>()
		.then((row) => row?.clicks ?? 0);

describe('consumer counts', () => {
	it('counts each outcome in the minute of the shard the event names', async () => {
		const first = event();
		const results = await consume([
			first,
			first,
			event({ occurredAt: start - 49 * 60 * 60 * 1000 }),
			event({ tenantId: 't-unprojected' }),
			event({ analyticsShardId: 'analytics-9' }),
			'not an event'
		]);
		expect(results).toEqual(['admitted', 'duplicate', 'dropped', 'retry', 'retry', 'dropped']);
		expect(await minuteRow(minute)).toEqual({
			counted: 1,
			duplicates: 1,
			dropped: 1,
			retried: 1,
			max_lag_ms: 30000,
			last_occurred_at: start - 30000
		});
	});

	it('adds a later batch to the same minute and keeps the largest lag', async () => {
		await consume([event({ occurredAt: start - 5000 }), event({ occurredAt: start - 90000 })]);
		expect(await minuteRow(minute)).toMatchObject({
			counted: 3,
			max_lag_ms: 90000,
			last_occurred_at: start - 5000
		});
	});

	it('counts a click whose counts cannot be stored', async () => {
		const real = shard();
		const failing = {
			prepare: (sql: string) => {
				if (sql.includes('ingestion_minutes')) throw new Error('stats unavailable');
				return real.prepare(sql);
			},
			batch: (statements: Parameters<D1Database['batch']>[0]) => real.batch(statements)
		} as unknown as D1Database;
		const before = await usage();
		const results = await consume([event()], start + 60000, { 'analytics-1': failing });
		expect(results).toEqual(['admitted']);
		expect(await usage()).toBe(before + 1);
		expect(await minuteRow(minute + 60000)).toBeNull();
	});

	it('sums the window and names the newest minute with a counted click', async () => {
		await consume([event({ occurredAt: start + 110000 })], start + 120000);
		const summary = await readIngestionSummary(shard(), minute);
		expect(summary).toMatchObject({
			counted: 4,
			duplicates: 1,
			dropped: 1,
			retried: 1,
			maxLagMs: 90000,
			lastCountedMinute: minute + 120000
		});
		const empty = await readIngestionSummary(shard(), minute + 10 * 60000);
		expect(empty).toMatchObject({ counted: 0, maxLagMs: 0, lastCountedMinute: minute + 120000 });
	});

	it('purges minutes after 14 days', async () => {
		await consume([event({ occurredAt: start - 20 * day })], start - 20 * day);
		expect(await minuteRow(minute - 20 * day)).not.toBeNull();
		await purgeExpired(shard(), start, 1000);
		expect(await minuteRow(minute - 20 * day)).toBeNull();
		expect(await minuteRow(minute)).not.toBeNull();
	});
});

describe('shard capacity', () => {
	it('samples the size and tenant count of each bound shard', async () => {
		await identity()
			.prepare(
				"INSERT INTO tenants (id, name, analytics_shard_id, created_at) VALUES ('t-a', 'A', 'analytics-1', 0), ('t-b', 'B', 'analytics-1', 0), ('t-c', 'C', 'analytics-2', 0)"
			)
			.run();
		const broken = {
			prepare() {
				throw new Error('database unavailable');
			}
		} as unknown as D1Database;
		const measured = await measureShards(
			identity(),
			{ 'analytics-1': shard(), 'analytics-2': broken },
			start
		);
		expect(measured[0]?.sample).toMatchObject({ shardId: 'analytics-1', tenants: 2 });
		expect(measured[0]?.sample?.sizeBytes).toBeGreaterThan(0);
		expect(measured[1]).toEqual({ shardId: 'analytics-2', sample: null });
		const rows = await identity()
			.prepare('SELECT shard_id FROM analytics_shard_samples WHERE sampled_at = ?')
			.bind(start)
			.all();
		expect(rows.results).toEqual([{ shard_id: 'analytics-1' }]);
	});

	it('projects growth over the horizon once the samples span a day', () => {
		const sample = (sampledAt: number, sizeBytes: number) => ({
			shardId: 'analytics-1',
			sampledAt,
			sizeBytes,
			tenants: 3
		});
		const young = projectShard({ latest: sample(day / 2, 5000), base: sample(0, 1000) }, 365);
		expect(young).toMatchObject({ growthPerDay: null, projectedBytes: 5000 });
		const growing = projectShard(
			{ latest: sample(14 * day, 15_000_000), base: sample(0, 1_000_000) },
			365
		);
		expect(growing).toMatchObject({ growthPerDay: 1_000_000, projectedBytes: 380_000_000 });
		const shrinking = projectShard({ latest: sample(2 * day, 500), base: sample(0, 900) }, 365);
		expect(shrinking).toMatchObject({ growthPerDay: 0, projectedBytes: 500 });
	});

	it('measures growth from the oldest sample inside the window', async () => {
		const insert = (sampledAt: number, size: number) =>
			identity()
				.prepare(
					"INSERT INTO analytics_shard_samples (shard_id, sampled_at, size_bytes, tenants) VALUES ('analytics-3', ?, ?, 1)"
				)
				.bind(sampledAt, size)
				.run();
		await insert(start - 30 * day, 0);
		await insert(start - 14 * day, 1_000_000);
		await insert(start - 7 * day, 8_000_000);
		await insert(start, 15_000_000);
		const [projection] = await readShardProjections(identity(), { 'analytics-3': shard() }, start, {
			windowDays: 14,
			horizonDays: 365
		});
		expect(projection).toMatchObject({
			shardId: 'analytics-3',
			sizeBytes: 15_000_000,
			growthPerDay: 1_000_000,
			measuredDays: 14,
			projectedBytes: 380_000_000
		});
		expect(
			await readShardProjections(identity(), { 'analytics-4': shard() }, start, {
				windowDays: 14,
				horizonDays: 365
			})
		).toEqual([]);
	});

	it('purges samples after 90 days', async () => {
		await purgeOperations(identity(), start + 61 * day, 1000);
		const left = await identity()
			.prepare("SELECT COUNT(*) AS n FROM analytics_shard_samples WHERE shard_id = 'analytics-3'")
			.first<{ n: number }>();
		expect(left?.n).toBe(3);
	});
});

describe('dead letters', () => {
	const deadLetters = (time = start) =>
		createDeadLetterConsumer({ identity: identity(), now: () => time });

	it('stores a valid event once and an invalid body without its fields', async () => {
		const valid = event();
		const messages = [
			message(valid, 'm-1'),
			message(valid, 'm-2'),
			message({ secret: 'https://private.example' }, 'm-3')
		];
		await deadLetters()({ messages: messages.map((item) => item.value) });
		expect(messages.every((item) => item.state.acked && !item.state.retried)).toBe(true);
		const rows = await identity()
			.prepare('SELECT id, shard_id, occurred_at, event FROM dead_letters ORDER BY id')
			.all<Record<string, unknown>>();
		expect(rows.results).toEqual([
			{
				id: `event:${valid.eventId}`,
				shard_id: 'analytics-1',
				occurred_at: valid.occurredAt,
				event: JSON.stringify(valid)
			},
			{ id: 'message:m-3', shard_id: null, occurred_at: null, event: null }
		]);
		expect(await countDeadLetters(identity(), start - 48 * 60 * 60 * 1000)).toEqual({
			total: 2,
			requeueable: 1
		});
		const listed = await listDeadLetters(identity(), 10);
		expect(listed.map((row) => [row.id, row.valid])).toEqual([
			[`event:${valid.eventId}`, true],
			['message:m-3', false]
		]);
	});

	it('retries a dead letter it cannot store', async () => {
		const broken = {
			prepare() {
				throw new Error('database unavailable');
			}
		} as unknown as D1Database;
		const item = message(event());
		await createDeadLetterConsumer({ identity: broken })({ messages: [item.value] });
		expect(item.state).toEqual({ acked: false, retried: true });
	});

	it('requeues a stored event once, and a counted event does not count again', async () => {
		const valid = event();
		await consume([valid]);
		const counted = await usage();
		await deadLetters()({ messages: [message(valid).value] });
		const sent: ClickEvent[] = [];
		const sink = { send: async (body: ClickEvent) => void sent.push(body) };
		expect(await requeueDeadLetter(identity(), sink, `event:${valid.eventId}`, start)).toBe(
			'requeued'
		);
		expect(await requeueDeadLetter(identity(), sink, `event:${valid.eventId}`, start)).toBe(
			'not_found'
		);
		expect(sent).toEqual([valid]);
		expect(await consume(sent)).toEqual(['duplicate']);
		expect(await usage()).toBe(counted);
	});

	it('keeps a dead letter it could not send, and never sends an expired or invalid one', async () => {
		const valid = event();
		await deadLetters()({ messages: [message(valid).value] });
		const failing = {
			send: async () => {
				throw new Error('queue unavailable');
			}
		};
		const id = `event:${valid.eventId}`;
		expect(await requeueDeadLetter(identity(), failing, id, start)).toBe('failed');
		const sent: ClickEvent[] = [];
		const sink = { send: async (body: ClickEvent) => void sent.push(body) };
		expect(await requeueDeadLetter(identity(), sink, id, start + 49 * 60 * 60 * 1000)).toBe(
			'expired'
		);
		expect(await requeueDeadLetter(identity(), sink, 'message:m-3', start)).toBe('not_found');
		expect(sent).toEqual([]);
		expect(await requeueDeadLetter(identity(), sink, id, start)).toBe('requeued');
	});

	it('purges dead letters after 7 days', async () => {
		await purgeOperations(identity(), start + 8 * day, 1000);
		expect(await countDeadLetters(identity(), 0)).toEqual({ total: 0, requeueable: 0 });
	});
});
