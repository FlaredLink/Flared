// SPDX-License-Identifier: AGPL-3.0-only
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import {
	normalizeReferrer,
	parseClickEvent,
	type ClickEvent
} from '../packages/contracts/src/analytics';
import {
	applyAnalyticsPolicy,
	ingestClick,
	purgeExpired,
	referrerLimit,
	type ClickRecord
} from '../packages/data/src/analytics';
import { createTenant } from '../packages/data/src/tenancy';
import {
	createClickConsumer,
	parseRange,
	type QueueMessage
} from '../packages/server/src/analytics';
import { createApi } from '../packages/server/src/api';
import { projectPolicy } from '../packages/server/src/tenancy';

const shard = () => env.ANALYTICS;
const identity = () => env.ANALYTICS_IDENTITY;
const routing = () => env.ANALYTICS_ROUTING;
const shards = () => ({ 'analytics-1': shard() });
const origin = 'https://app.example';
const day = 86400000;
const start = Date.UTC(2026, 9, 2, 12);

async function addPolicy(tenantId: string, monthlyClickLimit = 5000, retentionDays = 30) {
	await applyAnalyticsPolicy(shard(), {
		tenantId,
		revision: 1,
		monthlyClickLimit,
		retentionDays,
		now: 0
	});
}

let eventCounter = 0;
function click(tenantId: string, change: Partial<ClickRecord> = {}): ClickRecord {
	eventCounter += 1;
	return {
		tenantId,
		eventId: `event-${eventCounter}`,
		linkId: 'link-1',
		day: '2026-10-02',
		month: '2026-10',
		country: 'JP',
		device: 'mobile',
		referrer: 'news.example',
		...change
	};
}

async function scalar(sql: string, ...values: unknown[]): Promise<unknown> {
	const row = await shard()
		.prepare(sql)
		.bind(...values)
		.first<Record<string, unknown>>();
	return row ? Object.values(row)[0] : null;
}

const usage = (tenantId: string, month = '2026-10') =>
	scalar('SELECT clicks FROM monthly_usage WHERE tenant_id = ? AND month = ?', tenantId, month);
const total = (tenantId: string, linkDay = '2026-10-02') =>
	scalar(
		"SELECT clicks FROM daily_totals WHERE tenant_id = ? AND link_id = 'link-1' AND day = ?",
		tenantId,
		linkDay
	);
const dimensionRows = (tenantId: string) =>
	scalar('SELECT COUNT(*) FROM daily_dimensions WHERE tenant_id = ?', tenantId);

beforeAll(async () => {
	await applyD1Migrations(shard(), env.ANALYTICS_MIGRATIONS, 'flared_core_migrations');
	await applyD1Migrations(identity(), env.IDENTITY_MIGRATIONS, 'flared_core_migrations');
	await applyD1Migrations(routing(), env.ROUTING_MIGRATIONS, 'flared_core_migrations');
});

describe('ingestion', () => {
	it('counts an event once in every aggregate', async () => {
		await addPolicy('t-count');
		const record = click('t-count');
		expect(await ingestClick(shard(), record, 'token-a', start)).toBe('admitted');
		expect(await usage('t-count')).toBe(1);
		expect(await total('t-count')).toBe(1);
		const { results } = await shard()
			.prepare(
				'SELECT dimension, value, clicks FROM daily_dimensions WHERE tenant_id = ? ORDER BY dimension'
			)
			.bind('t-count')
			.all();
		expect(results).toEqual([
			{ dimension: 'country', value: 'JP', clicks: 1 },
			{ dimension: 'device', value: 'mobile', clicks: 1 },
			{ dimension: 'referrer', value: 'news.example', clicks: 1 }
		]);
	});

	it('changes nothing when a later attempt replays a committed event', async () => {
		await addPolicy('t-replay');
		const record = click('t-replay');
		expect(await ingestClick(shard(), record, 'token-a', start)).toBe('admitted');
		// Attempt A committed but its acknowledgement was lost; attempt B has a new token.
		expect(await ingestClick(shard(), record, 'token-b', start)).toBe('duplicate');
		expect(await usage('t-replay')).toBe(1);
		expect(await total('t-replay')).toBe(1);
		expect(
			await scalar(
				'SELECT attempt_token FROM event_receipts WHERE tenant_id = ? AND event_id = ?',
				't-replay',
				record.eventId
			)
		).toBe('token-a');
	});

	it('leaves nothing behind after a rolled-back attempt, so the retry counts', async () => {
		await addPolicy('t-rollback');
		const record = click('t-rollback');
		// A value that breaks the CHECK constraint fails the batch after the receipt insert.
		await expect(
			ingestClick(shard(), { ...record, day: null as unknown as string }, 'token-a', start)
		).rejects.toThrow();
		expect(
			await scalar('SELECT COUNT(*) FROM event_receipts WHERE tenant_id = ?', 't-rollback')
		).toBe(0);
		expect(await usage('t-rollback')).toBeNull();
		expect(await ingestClick(shard(), record, 'token-b', start)).toBe('admitted');
		expect(await usage('t-rollback')).toBe(1);
	});

	it('counts a duplicate inside one delivery once', async () => {
		await addPolicy('t-batch');
		const record = click('t-batch');
		const outcomes = await Promise.all([
			ingestClick(shard(), record, 'token-a', start),
			ingestClick(shard(), record, 'token-b', start)
		]);
		expect(outcomes.sort()).toEqual(['admitted', 'duplicate']);
		expect(await usage('t-batch')).toBe(1);
	});

	it('admits exactly the remaining allowance under concurrent batches', async () => {
		await addPolicy('t-quota', 3);
		const outcomes = await Promise.all(
			Array.from({ length: 8 }, (_, index) =>
				ingestClick(shard(), click('t-quota'), `token-${index}`, start)
			)
		);
		expect(outcomes.filter((outcome) => outcome === 'admitted')).toHaveLength(3);
		expect(outcomes.filter((outcome) => outcome === 'skipped')).toHaveLength(5);
		expect(await usage('t-quota')).toBe(3);
		expect(await total('t-quota')).toBe(3);
		expect(
			await scalar(
				"SELECT SUM(clicks) FROM daily_dimensions WHERE tenant_id = ? AND dimension = 'country'",
				't-quota'
			)
		).toBe(3);
	});

	it('never counts a skipped event after the allowance grows', async () => {
		await addPolicy('t-grow', 0);
		const record = click('t-grow');
		expect(await ingestClick(shard(), record, 'token-a', start)).toBe('skipped');
		expect(await dimensionRows('t-grow')).toBe(0);
		await applyAnalyticsPolicy(shard(), {
			tenantId: 't-grow',
			revision: 2,
			monthlyClickLimit: 100,
			retentionDays: 30,
			now: 1
		});
		expect(await ingestClick(shard(), record, 'token-b', start)).toBe('duplicate');
		expect(await usage('t-grow')).toBeNull();
	});

	it('resets the allowance at the UTC month boundary', async () => {
		await addPolicy('t-month', 1);
		expect(
			await ingestClick(
				shard(),
				click('t-month', { day: '2026-09-30', month: '2026-09' }),
				'a',
				start
			)
		).toBe('admitted');
		expect(
			await ingestClick(
				shard(),
				click('t-month', { day: '2026-09-30', month: '2026-09' }),
				'b',
				start
			)
		).toBe('skipped');
		expect(
			await ingestClick(
				shard(),
				click('t-month', { day: '2026-10-01', month: '2026-10' }),
				'c',
				start
			)
		).toBe('admitted');
		expect(await usage('t-month', '2026-09')).toBe(1);
		expect(await usage('t-month', '2026-10')).toBe(1);
	});

	it('writes nothing for a tenant without a policy on this shard', async () => {
		expect(await ingestClick(shard(), click('t-none'), 'a', start)).toBe('no_policy');
		expect(await scalar('SELECT COUNT(*) FROM event_receipts WHERE tenant_id = ?', 't-none')).toBe(
			0
		);
	});

	it('keeps at most 50 referrer names per link and day and counts the rest as other', async () => {
		await addPolicy('t-ref');
		for (let index = 0; index < referrerLimit; index += 1)
			await ingestClick(shard(), click('t-ref', { referrer: `site${index}.example` }), 'a', start);
		await ingestClick(shard(), click('t-ref', { referrer: 'late.example' }), 'a', start);
		await ingestClick(shard(), click('t-ref', { referrer: 'later.example' }), 'a', start);
		// A known name still counts under its name.
		await ingestClick(shard(), click('t-ref', { referrer: 'site0.example' }), 'a', start);
		const value = (name: string) =>
			scalar(
				"SELECT clicks FROM daily_dimensions WHERE tenant_id = 't-ref' AND dimension = 'referrer' AND value = ?",
				name
			);
		expect(await value('other')).toBe(2);
		expect(await value('site0.example')).toBe(2);
		expect(await value('late.example')).toBeNull();
		expect(
			await scalar(
				"SELECT COUNT(*) FROM daily_dimensions WHERE tenant_id = 't-ref' AND dimension = 'referrer'"
			)
		).toBe(referrerLimit + 1);
		// The total still counts every click.
		expect(await total('t-ref')).toBe(referrerLimit + 3);
		// Another day starts a new list.
		await ingestClick(
			shard(),
			click('t-ref', { referrer: 'late.example', day: '2026-10-03' }),
			'a',
			start
		);
		expect(
			await scalar(
				"SELECT clicks FROM daily_dimensions WHERE tenant_id = 't-ref' AND day = '2026-10-03' AND value = 'late.example'"
			)
		).toBe(1);
	});
});

describe('retention', () => {
	it('removes rows past each tenant retention and receipts past 72 hours', async () => {
		await addPolicy('t-old', 5000, 30);
		await addPolicy('t-long', 5000, 365);
		const now = Date.UTC(2026, 9, 31, 12);
		// With 30 days, 2026-10-02 is the oldest kept day and 2026-10-01 is expired.
		for (const [tenant, linkDay] of [
			['t-old', '2026-10-01'],
			['t-old', '2026-10-02'],
			['t-long', '2026-10-01']
		])
			await ingestClick(
				shard(),
				click(tenant, { day: linkDay, month: '2026-10' }),
				`token-${tenant}-${linkDay}`,
				now - 73 * 60 * 60 * 1000
			);
		await ingestClick(shard(), click('t-old', { day: '2026-10-31' }), 'fresh', now);
		let deleted = 0;
		// Earlier tests left receipts on this shard too, so purge until a round removes nothing.
		for (let round = 0; round < 1000; round += 1) {
			const result = await purgeExpired(shard(), now, 2);
			deleted += result.deleted;
			if (result.deleted === 0) break;
		}
		expect(deleted).toBeGreaterThan(0);
		expect(await total('t-old', '2026-10-01')).toBeNull();
		expect(await total('t-old', '2026-10-02')).toBe(1);
		expect(await total('t-long', '2026-10-01')).toBe(1);
		expect(
			await scalar(
				"SELECT COUNT(*) FROM daily_dimensions WHERE tenant_id = 't-old' AND day = '2026-10-01'"
			)
		).toBe(0);
		expect(
			await scalar("SELECT COUNT(*) FROM event_receipts WHERE tenant_id IN ('t-old', 't-long')")
		).toBe(1);
		// Usage is not an aggregate with retention; the month keeps its count.
		expect(await usage('t-old')).toBe(3);
	});
});

function event(change: Partial<ClickEvent> = {}): ClickEvent {
	return {
		schemaVersion: 1,
		eventId: crypto.randomUUID(),
		tenantId: 't-consumer',
		analyticsShardId: 'analytics-1',
		linkId: 'link-1',
		kind: 'production',
		occurredAt: start,
		country: 'DE',
		deviceCategory: 'desktop',
		referrerHostname: 'unknown',
		...change
	};
}

function message(body: unknown) {
	const state: { acked: boolean; retried: { delaySeconds?: number } | null } = {
		acked: false,
		retried: null
	};
	const value: QueueMessage = {
		body,
		ack: () => {
			state.acked = true;
		},
		retry: (options) => {
			state.retried = options ?? {};
		}
	};
	return { value, state };
}

describe('consumer', () => {
	const consume = (bodies: unknown[], shardMap: Record<string, D1Database> = shards()) => {
		const messages = bodies.map(message);
		return createClickConsumer({ shards: shardMap, now: () => start })({
			messages: messages.map((item) => item.value)
		}).then((results) => ({ results, states: messages.map((item) => item.state) }));
	};

	it('acknowledges counted, skipped, and duplicate events', async () => {
		await addPolicy('t-consumer');
		const first = event();
		const { results, states } = await consume([first, first, event()]);
		expect(results).toEqual(['admitted', 'duplicate', 'admitted']);
		expect(states.every((state) => state.acked && !state.retried)).toBe(true);
		expect(await usage('t-consumer')).toBe(2);
	});

	it('drops invalid, test, expired, and future events without counting them', async () => {
		const { results, states } = await consume([
			{ ...event(), destination: 'https://secret.example' },
			event({ kind: 'test', checkId: 'check-1' }),
			event({ occurredAt: start - 49 * 60 * 60 * 1000 }),
			event({ occurredAt: start + 10 * 60 * 1000 }),
			'not an event'
		]);
		expect(results).toEqual(['dropped', 'dropped', 'dropped', 'dropped', 'dropped']);
		expect(states.every((state) => state.acked)).toBe(true);
		expect(await usage('t-consumer')).toBe(2);
	});

	it('retries an event for an unbound shard or a missing policy, never another shard', async () => {
		const { results, states } = await consume([
			event({ analyticsShardId: 'analytics-9' }),
			event({ tenantId: 't-unprojected' })
		]);
		expect(results).toEqual(['retry', 'retry']);
		expect(states[0]).toEqual({ acked: false, retried: {} });
		expect(states[1]).toEqual({ acked: false, retried: { delaySeconds: 60 } });
		expect(
			await scalar('SELECT COUNT(*) FROM event_receipts WHERE tenant_id = ?', 't-unprojected')
		).toBe(0);
	});

	it('retries when the database fails', async () => {
		const broken = {
			prepare() {
				throw new Error('database unavailable');
			}
		} as unknown as D1Database;
		const { results, states } = await consume([event()], { 'analytics-1': broken });
		expect(results).toEqual(['retry']);
		expect(states[0].retried).toEqual({});
	});
});

describe('event contract', () => {
	it('accepts only the minimized fields', () => {
		expect(parseClickEvent(event())).not.toBeNull();
		expect(parseClickEvent({ ...event(), ip: '192.0.2.1' })).toBeNull();
		expect(parseClickEvent(event({ country: 'Japan' }))).toBeNull();
		expect(parseClickEvent(event({ referrerHostname: 'https://a.example/path' }))).toBeNull();
		expect(parseClickEvent(event({ tenantId: 'x'.repeat(65) }))).toBeNull();
		expect(parseClickEvent(event({ checkId: 'check-1' }))).toBeNull();
	});

	it('keeps only the referrer host name', () => {
		expect(normalizeReferrer('https://www.News.Example/a?b=c')).toBe('news.example');
		expect(normalizeReferrer('android-app://com.slack/')).toBe('unknown');
		expect(normalizeReferrer('http://localhost:3000/')).toBe('unknown');
		expect(normalizeReferrer('not a url')).toBe('unknown');
		expect(normalizeReferrer(null)).toBe('unknown');
	});

	it('clamps ranges to retention and today', () => {
		const now = Date.UTC(2026, 9, 31, 12);
		expect(parseRange({}, now, 30)).toEqual({ from: '2026-10-02', to: '2026-10-31' });
		expect(parseRange({}, now, 7)).toEqual({ from: '2026-10-25', to: '2026-10-31' });
		expect(parseRange({ from: '2026-01-01', to: '2026-12-31' }, now, 365)).toEqual({
			from: '2026-01-01',
			to: '2026-10-31'
		});
		expect(() => parseRange({ from: '2026-02-30' }, now, 30)).toThrow();
		expect(() => parseRange({ from: '2026-10-10', to: '2026-10-09' }, now, 30)).toThrow();
	});
});

describe('analytics API', () => {
	let clock = start;
	// null leaves the API without analytics bindings.
	const api = (analytics: Record<string, D1Database> | null = shards()) =>
		createApi({
			identity: identity(),
			routing: routing(),
			analytics: analytics ?? undefined,
			appOrigin: origin,
			authenticate: async (request) => {
				const userId = request.headers.get('x-test-user');
				return userId
					? { kind: 'session', userId, signedInAt: new Date(clock).toISOString() }
					: null;
			},
			now: () => clock
		});
	const get = (user: string, path: string, app = api()) =>
		app.fetch(new Request(`${origin}${path}`, { headers: { 'x-test-user': user } }));

	async function addTenant(userId: string, tenantId: string) {
		await identity()
			.prepare(
				'INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 0, 0)'
			)
			.bind(userId, '', `${userId}@example.com`)
			.run();
		await createTenant(identity(), {
			id: tenantId,
			name: 'Workspace',
			ownerUserId: userId,
			analyticsShardId: 'analytics-1',
			limits: { activeLinkLimit: 10, monthlyClickLimit: 5000, retentionDays: 30, domainLimit: 1 },
			now: 1
		});
		await projectPolicy(identity(), { routing: routing(), analytics: shards() }, tenantId, 1);
	}

	async function addLink(tenantId: string, linkId: string, slug: string) {
		await routing().batch([
			routing()
				.prepare('INSERT INTO slug_reservations (domain_id, slug) VALUES (?, ?)')
				.bind('dom-short', slug),
			routing()
				.prepare(
					"INSERT INTO links (id, tenant_id, domain_id, slug, destination, title, status, created_at, updated_at) VALUES (?, ?, 'dom-short', ?, 'https://example.com/', NULL, 'active', ?, 0)"
				)
				.bind(linkId, tenantId, slug, clock)
		]);
	}

	beforeAll(async () => {
		await identity()
			.prepare("INSERT INTO installation (id, mode, created_at) VALUES (1, 'multi', 0)")
			.run();
		await routing().batch([
			routing().prepare(
				"INSERT INTO domain_namespaces (id, hostname, created_at) VALUES ('dom-short', 'short.example', 0)"
			),
			routing().prepare(
				"INSERT INTO domains (id, tenant_id, state, is_default, created_at, updated_at) VALUES ('dom-short', NULL, 'active', 1, 0, 0)"
			)
		]);
		await addTenant('user-a', 'api-a');
		await addTenant('user-b', 'api-b');
		await addLink('api-a', 'link-a', 'alpha');
		await addLink('api-b', 'link-b', 'bravo');
		for (const [tenantId, linkId, linkDay] of [
			['api-a', 'link-a', '2026-10-01'],
			['api-a', 'link-a', '2026-10-02'],
			['api-a', 'link-a', '2026-10-02'],
			['api-b', 'link-b', '2026-10-02']
		])
			await ingestClick(
				shard(),
				click(tenantId, { linkId, day: linkDay, referrer: 'unknown' }),
				'token',
				start
			);
	});

	it('returns daily totals with empty days and the three breakdowns', async () => {
		const response = await get('user-a', '/v1/links/link-a/analytics?from=2026-09-30');
		expect(response.status).toBe(200);
		const { analytics } = (await response.json()) as { analytics: Record<string, unknown> };
		expect(analytics).toMatchObject({
			linkId: 'link-a',
			from: '2026-09-30',
			to: '2026-10-02',
			total: 3,
			days: [
				{ day: '2026-09-30', clicks: 0 },
				{ day: '2026-10-01', clicks: 1 },
				{ day: '2026-10-02', clicks: 2 }
			],
			countries: [{ value: 'JP', clicks: 3 }],
			devices: [{ value: 'mobile', clicks: 3 }],
			referrers: [{ value: 'unknown', clicks: 3 }],
			asOf: new Date(start).toISOString()
		});
	});

	it('hides another tenant link and its clicks', async () => {
		const response = await get('user-a', '/v1/links/link-b/analytics');
		expect(response.status).toBe(404);
	});

	it('lists links with clicks in the last 30 days', async () => {
		const { links } = (await (await get('user-a', '/v1/links')).json()) as {
			links: { id: string; clicksLast30Days: number | null }[];
		};
		expect(links).toEqual([expect.objectContaining({ id: 'link-a', clicksLast30Days: 3 })]);
		const without = (await (await get('user-a', '/v1/links', api(null))).json()) as {
			links: { clicksLast30Days: number | null }[];
		};
		expect(without.links[0].clicksLast30Days).toBeNull();
	});

	it('reports monthly usage against the allowance', async () => {
		const response = await get('user-b', '/v1/usage');
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			usage: {
				month: '2026-10',
				clicks: 1,
				clickLimit: 5000,
				asOf: new Date(start).toISOString()
			}
		});
	});

	it('answers 503 without analytics, 422 for a bad range, and 405 for writes', async () => {
		expect((await get('user-a', '/v1/usage', api(null))).status).toBe(503);
		expect((await get('user-a', '/v1/links/link-a/analytics', api({}))).status).toBe(503);
		expect((await get('user-a', '/v1/links/link-a/analytics?from=yesterday')).status).toBe(422);
		const post = await api().fetch(
			new Request(`${origin}/v1/usage`, {
				method: 'POST',
				headers: { 'x-test-user': 'user-a', origin }
			})
		);
		expect(post.status).toBe(405);
	});
});
