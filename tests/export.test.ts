// SPDX-License-Identifier: AGPL-3.0-only
// The workspace export pages against real D1: paging, isolation, retention, cursors, and scopes.
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { linksCsv } from '../packages/client/src/export';
import { oldestRetainedDay, utcDay } from '../packages/contracts/src/analytics';
import type { TokenScope } from '../packages/contracts/src/tokens';
import { createTenant } from '../packages/data/src/tenancy';
import { getExportDimensions, getExportTotals } from '../packages/server/src/analytics';
import { createApi } from '../packages/server/src/api';
import { exportLinks } from '../packages/server/src/links';
import { projectPolicy } from '../packages/server/src/tenancy';

const identity = () => env.EXPORT_IDENTITY;
const routing = () => env.EXPORT_ROUTING;
const shard = () => env.EXPORT_ANALYTICS;
const shards = () => ({ 'analytics-1': shard() });
const origin = 'https://app.example';
const now = Date.UTC(2026, 9, 20, 12);
const today = utcDay(now);
const oldest = oldestRetainedDay(now, 30);
const dayBefore = (day: string, days: number) =>
	utcDay(Date.parse(`${day}T00:00:00Z`) - days * 86400000);

async function addTenant(name: string): Promise<string> {
	const tenantId = `t-${name}`;
	await identity()
		.prepare(
			'INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 0, 0)'
		)
		.bind(`user-${name}`, '', `${name}@example.com`)
		.run();
	await createTenant(identity(), {
		id: tenantId,
		name: 'Workspace',
		ownerUserId: `user-${name}`,
		analyticsShardId: 'analytics-1',
		limits: { activeLinkLimit: 100, monthlyClickLimit: 5000, retentionDays: 30, domainLimit: 1 },
		now: 1
	});
	await projectPolicy(identity(), { routing: routing(), analytics: shards() }, tenantId, 1);
	return tenantId;
}

async function addLinks(tenantId: string, count: number, enabled = true) {
	await routing().batch(
		Array.from({ length: count }, (_, index) => [
			routing()
				.prepare("INSERT INTO slug_reservations (domain_id, slug) VALUES ('dom-short', ?)")
				.bind(`${tenantId}-${index}`),
			routing()
				.prepare(
					"INSERT INTO links (id, tenant_id, domain_id, slug, destination, title, status, created_at, updated_at) VALUES (?, ?, 'dom-short', ?, 'https://example.com/a', NULL, ?, ?, ?)"
				)
				.bind(
					`${tenantId}-link-${index}`,
					tenantId,
					`${tenantId}-${index}`,
					enabled ? 'active' : 'disabled',
					index,
					index
				)
		]).flat()
	);
}

async function addRows(tenantId: string, linkId: string, days: string[]) {
	await shard().batch(
		days.flatMap((day) => [
			shard()
				.prepare('INSERT INTO daily_totals (tenant_id, link_id, day, clicks) VALUES (?, ?, ?, 2)')
				.bind(tenantId, linkId, day),
			...['JP', 'US'].map((value) =>
				shard()
					.prepare(
						"INSERT INTO daily_dimensions (tenant_id, link_id, day, dimension, value, clicks) VALUES (?, ?, ?, 'country', ?, 1)"
					)
					.bind(tenantId, linkId, day, value)
			)
		])
	);
}

const api = (scopes: TokenScope[] | null = null) =>
	createApi({
		identity: identity(),
		routing: routing(),
		analytics: shards(),
		appOrigin: origin,
		authenticate: async (request) => {
			const name = request.headers.get('x-test-user');
			if (!name) return null;
			if (!scopes) return { kind: 'session', userId: `user-${name}`, signedInAt: '' };
			return {
				kind: 'oauth',
				userId: `user-${name}`,
				tenantId: `t-${name}`,
				scopes,
				clientId: 'client'
			};
		},
		now: () => now
	});

async function get(path: string, name: string, scopes: TokenScope[] | null = null) {
	return api(scopes).fetch(
		new Request(`${origin}/v1${path}`, { headers: { 'x-test-user': name } })
	);
}

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
	const one = await addTenant('one');
	const two = await addTenant('two');
	await addLinks(one, 5);
	await addLinks(two, 3);
	await routing()
		.prepare("UPDATE links SET status = 'disabled' WHERE id = ?")
		.bind(`${one}-link-4`)
		.run();
	await addRows(one, `${one}-link-0`, [today, dayBefore(today, 1), oldest]);
	await addRows(one, `${one}-link-1`, [today, dayBefore(oldest, 1), dayBefore(oldest, 40)]);
	await addRows(two, `${two}-link-0`, [today]);
});

describe('workspace export', () => {
	it('pages every link, active and disabled, without another workspace', async () => {
		const ids: string[] = [];
		let cursor: string | null = null;
		let guard = 0;
		let pages = 0;
		do {
			const page = await exportLinks(routing(), 't-one', cursor, 2);
			expect(page.links.length).toBeLessThanOrEqual(2);
			ids.push(...page.links.map((link) => link.id));
			cursor = page.nextCursor;
			pages += 1;
		} while (cursor && ++guard < 20);
		expect(pages).toBe(3);
		expect(ids).toEqual([4, 3, 2, 1, 0].map((index) => `t-one-link-${index}`));
		const response = await get('/export/links', 'one');
		const body = (await response.json()) as { links: { id: string; enabled: boolean }[] };
		expect(body.links.find((link) => link.id === 't-one-link-4')?.enabled).toBe(false);
		expect(body.links.every((link) => link.id.startsWith('t-one-'))).toBe(true);
	});

	it('pages retained daily rows in key order and leaves out older days', async () => {
		const totals: string[] = [];
		let cursor: string | null = null;
		let guard = 0;
		do {
			const page = await getExportTotals(identity(), shards(), 't-one', cursor, now, 2);
			expect(page).toMatchObject({ from: oldest, retentionDays: 30 });
			totals.push(...page.rows.map((row) => `${row.linkId} ${row.day}`));
			cursor = page.nextCursor;
		} while (cursor && ++guard < 20);
		expect(totals).toEqual([
			`t-one-link-0 ${oldest}`,
			`t-one-link-0 ${dayBefore(today, 1)}`,
			`t-one-link-0 ${today}`,
			`t-one-link-1 ${today}`
		]);

		const dimensions: string[] = [];
		cursor = null;
		guard = 0;
		do {
			const page = await getExportDimensions(identity(), shards(), 't-one', cursor, now, 3);
			dimensions.push(...page.rows.map((row) => `${row.linkId} ${row.day} ${row.value}`));
			cursor = page.nextCursor;
		} while (cursor && ++guard < 20);
		expect(dimensions).toHaveLength(8);
		expect(dimensions.every((row) => row.startsWith('t-one-'))).toBe(true);
		expect(dimensions.slice(0, 2)).toEqual([
			`t-one-link-0 ${oldest} JP`,
			`t-one-link-0 ${oldest} US`
		]);
	});

	it('refuses a cursor it did not make', async () => {
		for (const path of [
			'/export/links?cursor=nope',
			'/export/daily-totals?cursor=nope!',
			`/export/daily-totals?cursor=${btoa('["a"]')}`,
			`/export/daily-dimensions?cursor=${btoa('["a","2026-10-01","colour","x"]').replace(/=+$/, '')}`
		]) {
			const response = await get(path, 'one');
			expect(response.status, path).toBe(422);
			expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
				'INVALID_INPUT'
			);
		}
	});

	it('needs links:read for links and analytics:read for analytics', async () => {
		expect((await get('/export/links', 'one', ['links:read'])).status).toBe(200);
		expect((await get('/export/daily-totals', 'one', ['links:read'])).status).toBe(403);
		expect((await get('/export/daily-dimensions', 'one', ['analytics:read'])).status).toBe(200);
		expect((await get('/export/links', 'one', ['analytics:read'])).status).toBe(403);
	});

	it('writes links as CSV that a spreadsheet cannot run as formulas', () => {
		const link = {
			id: 'l1',
			domainId: 'd1',
			hostname: 'short.example',
			slug: 'launch',
			shortUrl: 'https://short.example/launch',
			destination: 'https://example.com/?a=1,b="2"',
			title: '=HYPERLINK("https://evil.example")',
			enabled: false,
			createdAt: '2026-10-20T00:00:00.000Z',
			updatedAt: '2026-10-20T00:00:00.000Z'
		};
		expect(linksCsv([link, { ...link, id: 'l2', title: null }]).split('\r\n')).toEqual([
			'id,shortUrl,hostname,slug,destination,title,enabled,createdAt,updatedAt',
			'l1,https://short.example/launch,short.example,launch,"https://example.com/?a=1,b=""2""","\'=HYPERLINK(""https://evil.example"")",false,2026-10-20T00:00:00.000Z,2026-10-20T00:00:00.000Z',
			'l2,https://short.example/launch,short.example,launch,"https://example.com/?a=1,b=""2""",,false,2026-10-20T00:00:00.000Z,2026-10-20T00:00:00.000Z',
			''
		]);
	});
});
