// SPDX-License-Identifier: AGPL-3.0-only
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { usageLevel, usageWarnings } from '../packages/contracts/src/analytics';
import { ingestClick } from '../packages/data/src/analytics';
import { claimNotices, noticeLifetimeMs } from '../packages/data/src/notices';
import { createTenant, type PolicyLimits } from '../packages/data/src/tenancy';
import { createApi } from '../packages/server/src/api';
import type { EmailContent } from '../packages/server/src/email/transport';
import {
	cleanupNotices,
	dispatchNotices,
	reconcileClickNotices,
	reconcileLimitNotices,
	usageNoticeEmail
} from '../packages/server/src/notices';
import { projectPolicy, updatePolicy } from '../packages/server/src/tenancy';

const identity = () => env.USAGE_IDENTITY;
const routing = () => env.USAGE_ROUTING;
const shard = () => env.USAGE_ANALYTICS;
const shards = () => ({ 'analytics-1': shard() });
const stores = () => ({ routing: routing(), analytics: shards() });
const origin = 'https://app.example';
const start = Date.UTC(2026, 9, 20, 12);
const free: PolicyLimits = {
	activeLinkLimit: 5,
	monthlyClickLimit: 10,
	retentionDays: 30,
	domainLimit: 1
};

async function addTenant(name: string, limits = free, verified = true): Promise<string> {
	const userId = `user-${name}`;
	const tenantId = `t-${name}`;
	await identity()
		.prepare(
			'INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, ?, 0, 0)'
		)
		.bind(userId, '', `${name}@example.com`, verified ? 1 : 0)
		.run();
	await createTenant(identity(), {
		id: tenantId,
		name: 'Workspace',
		ownerUserId: userId,
		analyticsShardId: 'analytics-1',
		limits,
		now: 1
	});
	await projectPolicy(identity(), stores(), tenantId, 1);
	return tenantId;
}

let eventCounter = 0;
async function clicks(tenantId: string, count: number, month = '2026-10') {
	for (let index = 0; index < count; index += 1) {
		eventCounter += 1;
		await ingestClick(
			shard(),
			{
				tenantId,
				eventId: `event-${eventCounter}`,
				linkId: 'link-1',
				day: `${month}-15`,
				month,
				country: 'JP',
				device: 'mobile',
				referrer: 'unknown',
				browser: 'chrome',
				os: 'windows'
			},
			`token-${eventCounter}`,
			start
		);
	}
}

const api = () =>
	createApi({
		identity: identity(),
		routing: routing(),
		analytics: shards(),
		appOrigin: origin,
		authenticate: async (request) => {
			const userId = request.headers.get('x-test-user');
			return userId ? { kind: 'session', userId, signedInAt: new Date(start).toISOString() } : null;
		},
		now: () => start
	});

async function usageOf(tenantId: string) {
	const response = await api().fetch(
		new Request(`${origin}/v1/usage`, {
			headers: { 'x-test-user': tenantId.replace(/^t-/, 'user-') }
		})
	);
	expect(response.status).toBe(200);
	return ((await response.json()) as { usage: Record<string, unknown> }).usage;
}

let keyCounter = 0;
async function createLinks(tenantId: string, count: number): Promise<number[]> {
	const statuses: number[] = [];
	for (let index = 0; index < count; index += 1) {
		keyCounter += 1;
		const response = await api().fetch(
			new Request(`${origin}/v1/links`, {
				method: 'POST',
				headers: {
					'x-test-user': tenantId.replace(/^t-/, 'user-'),
					origin,
					'content-type': 'application/json',
					'idempotency-key': `key-${keyCounter}`
				},
				body: JSON.stringify({ destination: `https://example.com/${keyCounter}` })
			})
		);
		statuses.push(response.status);
	}
	return statuses;
}

async function notices(tenantId: string) {
	const { results } = await identity()
		.prepare(
			'SELECT kind, dedupe_key, params, state FROM notices WHERE tenant_id = ? ORDER BY created_at, dedupe_key'
		)
		.bind(tenantId)
		.all<{ kind: string; dedupe_key: string; params: string; state: string }>();
	return results;
}

// Sorted, because notices recorded in the same millisecond have no order.
const keys = async (tenantId: string) =>
	(await notices(tenantId)).map((row) => row.dedupe_key).sort();

function recorder(fail = false) {
	const sent: EmailContent[] = [];
	return {
		sent,
		transport: {
			async send(message: EmailContent) {
				if (fail) throw new Error('send failed');
				sent.push(message);
			}
		}
	};
}

const render = (notice: Parameters<typeof usageNoticeEmail>[0], to: string): EmailContent | null =>
	usageNoticeEmail(notice, to, `${origin}/app`);

beforeAll(async () => {
	await applyD1Migrations(identity(), env.IDENTITY_MIGRATIONS, 'flared_core_migrations');
	await applyD1Migrations(routing(), env.ROUTING_MIGRATIONS, 'flared_core_migrations');
	await applyD1Migrations(shard(), env.ANALYTICS_MIGRATIONS, 'flared_core_migrations');
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
});

describe('usage levels', () => {
	it('warns at 80% and 100%, and never for a limit of 0', () => {
		expect(usageLevel(7, 10)).toBeNull();
		expect(usageLevel(8, 10)).toBe(80);
		expect(usageLevel(10, 10)).toBe(100);
		expect(usageLevel(12, 10)).toBe(100);
		expect(usageLevel(0, 0)).toBeNull();
		expect(usageLevel(3, 0)).toBeNull();
		expect(
			usageWarnings({
				clicks: 9,
				clickLimit: 10,
				links: { used: 1, limit: 5 },
				domains: { used: 1, limit: 1 }
			})
		).toEqual([
			{ resource: 'clicks', level: 80 },
			{ resource: 'domains', level: 100 }
		]);
	});
});

describe('policy updates', () => {
	it('stores each update as a new revision and projects it to every store', async () => {
		const tenantId = await addTenant('update');
		const plus = {
			activeLinkLimit: 50,
			monthlyClickLimit: 1000,
			retentionDays: 365,
			domainLimit: 5
		};
		expect(await updatePolicy(identity(), stores(), tenantId, plus, 10)).toEqual({
			revision: 2,
			projected: true
		});
		expect(
			await routing()
				.prepare(
					'SELECT revision, active_link_limit, domain_limit FROM tenant_policy WHERE tenant_id = ?'
				)
				.bind(tenantId)
				.first()
		).toEqual({ revision: 2, active_link_limit: 50, domain_limit: 5 });
		expect(
			await shard()
				.prepare(
					'SELECT revision, monthly_click_limit, retention_days FROM tenant_policy WHERE tenant_id = ?'
				)
				.bind(tenantId)
				.first()
		).toEqual({ revision: 2, monthly_click_limit: 1000, retention_days: 365 });
	});

	it('gives concurrent updates distinct revisions, and the newest one wins', async () => {
		const tenantId = await addTenant('race');
		const results = await Promise.all(
			[10, 20, 30, 40].map((links) =>
				updatePolicy(identity(), stores(), tenantId, { ...free, activeLinkLimit: links }, 10)
			)
		);
		expect(results.map((result) => result.revision).sort()).toEqual([2, 3, 4, 5]);
		const newest = await identity()
			.prepare('SELECT revision, active_link_limit FROM tenant_policy WHERE tenant_id = ?')
			.bind(tenantId)
			.first<{ revision: number; active_link_limit: number }>();
		const projected = await routing()
			.prepare('SELECT revision, active_link_limit FROM tenant_policy WHERE tenant_id = ?')
			.bind(tenantId)
			.first();
		expect(newest?.revision).toBe(5);
		expect(projected).toEqual(newest);
	});

	it('keeps the identity update when a store fails, for the retry job to finish', async () => {
		const tenantId = await addTenant('deferred');
		const broken = {
			prepare() {
				throw new Error('routing unavailable');
			}
		} as unknown as D1Database;
		const result = await updatePolicy(
			identity(),
			{ routing: broken, analytics: shards() },
			tenantId,
			{ ...free, activeLinkLimit: 99 },
			10
		);
		expect(result).toEqual({ revision: 2, projected: false });
		expect(
			await identity()
				.prepare('SELECT routing_revision FROM tenant_policy WHERE tenant_id = ?')
				.bind(tenantId)
				.first()
		).toEqual({ routing_revision: 1 });
	});

	it('refuses an unknown tenant and invalid limits', async () => {
		await expect(updatePolicy(identity(), stores(), 't-missing', free, 10)).rejects.toThrow();
		const tenantId = await addTenant('invalid');
		await expect(
			updatePolicy(identity(), stores(), tenantId, { ...free, retentionDays: 0 }, 10)
		).rejects.toThrow('Invalid policy limits');
	});

	it('keeps existing links active when the link limit drops below their count', async () => {
		const tenantId = await addTenant('lower');
		expect(await createLinks(tenantId, 3)).toEqual([201, 201, 201]);
		await updatePolicy(identity(), stores(), tenantId, { ...free, activeLinkLimit: 1 }, 10);
		expect(
			await routing()
				.prepare("SELECT COUNT(*) AS active FROM links WHERE tenant_id = ? AND status = 'active'")
				.bind(tenantId)
				.first()
		).toEqual({ active: 3 });
		expect(await createLinks(tenantId, 1)).toEqual([403]);
	});
});

describe('usage API', () => {
	it('reports links, domains, unrecorded clicks, and warnings for the caller only', async () => {
		const tenantId = await addTenant('report');
		const other = await addTenant('other');
		await createLinks(tenantId, 4);
		await clicks(tenantId, 12);
		await clicks(other, 1);
		expect(await usageOf(tenantId)).toEqual({
			month: '2026-10',
			clicks: 10,
			clickLimit: 10,
			unrecordedClicks: 2,
			unrecordedSince: new Date(start).toISOString(),
			links: { used: 4, limit: 5 },
			domains: { used: 0, limit: 1 },
			retentionDays: 30,
			warnings: [
				{ resource: 'clicks', level: 100 },
				{ resource: 'links', level: 80 }
			],
			asOf: new Date(start).toISOString()
		});
		const otherUsage = await usageOf(other);
		expect(otherUsage.clicks).toBe(1);
		expect(otherUsage.links).toEqual({ used: 0, limit: 5 });
		expect(otherUsage.warnings).toEqual([]);
	});
});

describe('usage notices', () => {
	it('records one click notice per threshold and month, even from concurrent runs', async () => {
		const tenantId = await addTenant('clicks');
		await clicks(tenantId, 8);
		await Promise.all([
			reconcileClickNotices(identity(), shards(), start),
			reconcileClickNotices(identity(), shards(), start)
		]);
		expect(await keys(tenantId)).toEqual([`usage:clicks:${tenantId}:2026-10:80`]);
		await clicks(tenantId, 3);
		await reconcileClickNotices(identity(), shards(), start);
		await reconcileClickNotices(identity(), shards(), start);
		expect(await keys(tenantId)).toEqual(
			[`usage:clicks:${tenantId}:2026-10:80`, `usage:clicks:${tenantId}:2026-10:100`].sort()
		);
		// A new month starts again below the threshold.
		await reconcileClickNotices(identity(), shards(), Date.UTC(2026, 10, 2));
		expect(await keys(tenantId)).toHaveLength(2);
	});

	it('records only the highest threshold when usage passes both at once', async () => {
		const tenantId = await addTenant('jump');
		await clicks(tenantId, 10);
		await reconcileClickNotices(identity(), shards(), start);
		expect(await keys(tenantId)).toEqual([`usage:clicks:${tenantId}:2026-10:100`]);
	});

	it('stores only counts and dates in a notice', async () => {
		const tenantId = await addTenant('params');
		await clicks(tenantId, 9);
		await reconcileClickNotices(identity(), shards(), start);
		const [row] = await notices(tenantId);
		expect(JSON.parse(row.params)).toEqual({
			resource: 'clicks',
			level: 80,
			used: 9,
			limit: 10,
			period: '2026-10'
		});
	});

	it('records link notices at creation, and again after a lowered limit', async () => {
		const tenantId = await addTenant('links');
		await createLinks(tenantId, 3);
		expect(await keys(tenantId)).toEqual([]);
		await createLinks(tenantId, 1);
		expect(await keys(tenantId)).toEqual([`usage:links:${tenantId}:r1:80`]);
		await createLinks(tenantId, 1);
		await reconcileLimitNotices(identity(), routing(), start);
		expect(await keys(tenantId)).toEqual(
			[`usage:links:${tenantId}:r1:80`, `usage:links:${tenantId}:r1:100`].sort()
		);
		// A higher limit clears the warning; a lower one warns again under the new revision.
		await updatePolicy(identity(), stores(), tenantId, { ...free, activeLinkLimit: 100 }, 10);
		await reconcileLimitNotices(identity(), routing(), start);
		expect(await keys(tenantId)).toHaveLength(2);
		await updatePolicy(identity(), stores(), tenantId, { ...free, activeLinkLimit: 2 }, 10);
		await reconcileLimitNotices(identity(), routing(), start);
		expect(await keys(tenantId)).toContain(`usage:links:${tenantId}:r3:100`);
	});

	it('never records a notice for a tenant that does not exist', async () => {
		await routing()
			.prepare(
				"INSERT INTO tenant_policy (tenant_id, revision, analytics_shard_id, active_link_limit, domain_limit, updated_at) VALUES ('t-ghost', 1, 'analytics-1', 0, 0, 0)"
			)
			.run();
		await routing()
			.prepare(
				"INSERT INTO tenant_policy (tenant_id, revision, analytics_shard_id, active_link_limit, domain_limit, updated_at) VALUES ('t-ghost-full', 1, 'analytics-1', 1, 1, 0)"
			)
			.run();
		await routing().batch([
			routing().prepare(
				"INSERT INTO slug_reservations (domain_id, slug) VALUES ('dom-short', 'ghost')"
			),
			routing().prepare(
				"INSERT INTO links (id, tenant_id, domain_id, slug, destination, title, status, created_at, updated_at) VALUES ('ghost-link', 't-ghost-full', 'dom-short', 'ghost', 'https://example.com/', NULL, 'active', 0, 0)"
			)
		]);
		await reconcileLimitNotices(identity(), routing(), start);
		expect(await keys('t-ghost-full')).toEqual([]);
	});
});

describe('notice dispatcher', () => {
	it('sends each notice once to the verified owner', async () => {
		const tenantId = await addTenant('send');
		await clicks(tenantId, 10);
		await reconcileClickNotices(identity(), shards(), start);
		const mail = recorder();
		const first = await dispatchNotices({
			identity: identity(),
			transport: mail.transport,
			render,
			now: start,
			limit: 100
		});
		expect(first.sent).toBeGreaterThanOrEqual(1);
		const mine = mail.sent.filter((message) => message.to === 'send@example.com');
		expect(mine).toHaveLength(1);
		expect(mine[0].subject).toBe('Your Flared workspace reached its monthly click limit');
		expect(mine[0].text).toContain('until 2026-11-01');
		expect(mine[0].text).toContain(`${origin}/app`);
		const again = recorder();
		await dispatchNotices({
			identity: identity(),
			transport: again.transport,
			render,
			now: start,
			limit: 100
		});
		expect(again.sent.filter((message) => message.to === 'send@example.com')).toEqual([]);
		expect((await notices(tenantId)).map((row) => row.state)).toEqual(['sent']);
	});

	it('marks a failed send delivery_unknown and never sends it again', async () => {
		const tenantId = await addTenant('fail');
		await clicks(tenantId, 10);
		await reconcileClickNotices(identity(), shards(), start);
		await dispatchNotices({
			identity: identity(),
			transport: recorder(true).transport,
			render,
			now: start,
			limit: 100
		});
		expect((await notices(tenantId)).map((row) => row.state)).toEqual(['delivery_unknown']);
		const later = recorder();
		await dispatchNotices({
			identity: identity(),
			transport: later.transport,
			render,
			now: start + 60000,
			limit: 100
		});
		expect(later.sent.filter((message) => message.to === 'fail@example.com')).toEqual([]);
	});

	it('does not send to an unverified owner or for an unknown kind', async () => {
		const tenantId = await addTenant('unverified', free, false);
		await clicks(tenantId, 10);
		await reconcileClickNotices(identity(), shards(), start);
		const known = await addTenant('unknown-kind');
		await identity()
			.prepare(
				"INSERT INTO notices (id, tenant_id, kind, dedupe_key, params, created_at) VALUES ('n-unknown', ?, 'other', 'other:1', '{}', 0)"
			)
			.bind(known)
			.run();
		const mail = recorder();
		await dispatchNotices({
			identity: identity(),
			transport: mail.transport,
			render,
			now: start,
			limit: 100
		});
		expect(mail.sent.filter((message) => message.to === 'unverified@example.com')).toEqual([]);
		expect((await notices(tenantId)).map((row) => row.state)).toEqual(['undeliverable']);
		expect((await notices(known)).map((row) => row.state)).toEqual(['undeliverable']);
	});

	it('gives concurrent dispatchers separate notices', async () => {
		for (const name of ['c1', 'c2', 'c3', 'c4']) {
			const tenantId = await addTenant(name);
			await clicks(tenantId, 10);
		}
		await reconcileClickNotices(identity(), shards(), start);
		const [a, b] = await Promise.all([
			claimNotices(identity(), start, 100),
			claimNotices(identity(), start, 100)
		]);
		const ids = [...a, ...b].map((notice) => notice.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids.length).toBeGreaterThanOrEqual(4);
	});

	it('gives up on a claim older than 15 minutes without sending it', async () => {
		const tenantId = await addTenant('stale');
		await clicks(tenantId, 10);
		await reconcileClickNotices(identity(), shards(), start);
		await claimNotices(identity(), start, 100);
		const mail = recorder();
		const result = await dispatchNotices({
			identity: identity(),
			transport: mail.transport,
			render,
			now: start + 16 * 60000,
			limit: 100
		});
		expect(result.delivery_unknown).toBeGreaterThanOrEqual(1);
		expect(mail.sent.filter((message) => message.to === 'stale@example.com')).toEqual([]);
		expect((await notices(tenantId)).map((row) => row.state)).toEqual(['delivery_unknown']);
	});

	it('deletes notices after their lifetime', async () => {
		const tenantId = await addTenant('expire');
		await clicks(tenantId, 10);
		await reconcileClickNotices(identity(), shards(), start);
		await cleanupNotices(identity(), start + noticeLifetimeMs - 1);
		expect(await keys(tenantId)).toHaveLength(1);
		await cleanupNotices(identity(), start + noticeLifetimeMs + 1);
		expect(await keys(tenantId)).toEqual([]);
	});
});

describe('usage notice email', () => {
	const notice = (params: Record<string, string | number>) => ({
		id: 'n',
		tenantId: 't',
		kind: 'usage',
		params,
		email: 'owner@example.com'
	});

	it('describes link and domain limits and escapes the URL', () => {
		const email = usageNoticeEmail(
			notice({ resource: 'domains', level: 100, used: 1, limit: 1, period: 'r1' }),
			'owner@example.com',
			'https://app.example/app?a=<b>'
		);
		expect(email?.subject).toBe('Your Flared workspace reached its limit of custom domains');
		expect(email?.text).toContain('You cannot add more domains until the limit rises.');
		expect(email?.html).toContain('https://app.example/app?a=&lt;b&gt;');
		expect(email?.html).not.toContain('<b>');
	});

	it('returns null for bad params', () => {
		expect(
			usageNoticeEmail(
				notice({ resource: 'links', level: 50, used: 1, limit: 1, period: 'r1' }),
				'a@example.com',
				origin
			)
		).toBeNull();
		expect(
			usageNoticeEmail(
				notice({ resource: 'x', level: 80, used: 1, limit: 1, period: 'r1' }),
				'a@example.com',
				origin
			)
		).toBeNull();
	});
});
