// SPDX-License-Identifier: AGPL-3.0-only
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createRedirectHandler, snapshotLifetimeMs } from '../packages/server/src/redirect';

const appOrigin = 'https://app.example';
const routing = () => env.REDIRECT_ROUTING;
const start = Date.UTC(2026, 9, 2);

// Each handler gets its own cache, so snapshots never leak between tests.
let cacheCounter = 0;
function handler(options: { now?: () => number; db?: D1Database; cacheName?: string } = {}) {
	cacheCounter += 1;
	return createRedirectHandler({
		routing: options.db ?? routing(),
		appOrigin,
		cacheName: options.cacheName ?? `redirect-test-${cacheCounter}`,
		now: options.now ?? (() => start)
	});
}

function visit(app: ReturnType<typeof handler>, url: string, method = 'GET') {
	return app.fetch(new Request(url, { method, redirect: 'manual' }));
}

let linkCounter = 0;
async function addLink(
	slug: string,
	destination: string,
	options: { tenant?: string; domain?: string } = {}
) {
	linkCounter += 1;
	const domain = options.domain ?? 'dom-short';
	await routing().batch([
		routing()
			.prepare('INSERT INTO slug_reservations (domain_id, slug) VALUES (?, ?)')
			.bind(domain, slug),
		routing()
			.prepare(
				"INSERT INTO links (id, tenant_id, domain_id, slug, destination, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, 'active', 0, 0)"
			)
			.bind(`link-${linkCounter}`, options.tenant ?? 'tenant-a', domain, slug, destination)
	]);
}

function setLink(slug: string, change: { destination?: string; status?: string }) {
	return routing()
		.prepare(
			'UPDATE links SET destination = COALESCE(?, destination), status = COALESCE(?, status) WHERE slug = ?'
		)
		.bind(change.destination ?? null, change.status ?? null, slug)
		.run();
}

beforeAll(async () => {
	await applyD1Migrations(routing(), env.ROUTING_MIGRATIONS, 'flared_core_migrations');
	await routing().batch([
		routing().prepare(
			"INSERT INTO domain_namespaces (id, hostname, created_at) VALUES ('dom-short', 'short.example', 0), ('dom-owned', 'owned.example', 0), ('dom-off', 'off.example', 0)"
		),
		routing().prepare(
			"INSERT INTO domains (id, tenant_id, state, is_default, created_at, updated_at) VALUES ('dom-short', NULL, 'active', 1, 0, 0), ('dom-owned', 'tenant-b', 'active', 0, 0, 0), ('dom-off', NULL, 'disabled', 0, 0, 0)"
		),
		routing().prepare(
			"INSERT INTO tenant_policy (tenant_id, revision, analytics_shard_id, active_link_limit, domain_limit, updated_at) VALUES ('tenant-a', 1, 'analytics-1', 100, 1, 0), ('tenant-b', 1, 'analytics-1', 100, 1, 0)"
		)
	]);
});

describe('redirects', () => {
	it('sends an active link to its exact destination without caching the response', async () => {
		const destination = 'https://example.com/launch?utm_source=x&q=%20a#part';
		await addLink('launch', destination);
		const response = await visit(handler(), 'https://short.example/launch?ignored=1');
		expect(response.status).toBe(302);
		expect(response.headers.get('location')).toBe(destination);
		expect(response.headers.get('cache-control')).toBe('no-store');
	});

	it('normalizes the host name', async () => {
		await addLink('host-case', 'https://example.com/host');
		const response = await visit(handler(), 'https://SHORT.example./host-case');
		expect(response.status).toBe(302);
	});

	it('returns a generic 404 for unknown, disabled, and malformed paths', async () => {
		await addLink('off-link', 'https://example.com/off');
		await setLink('off-link', { status: 'disabled' });
		const app = handler();
		for (const path of ['/missing', '/off-link', '/launch/', '/launch/more', '/a', '/Launch'])
			expect((await visit(app, `https://short.example${path}`)).status, path).toBe(404);
	});

	it('fails closed for unknown and disabled hosts', async () => {
		await addLink('off-domain', 'https://example.com/x', { domain: 'dom-off' });
		const app = handler();
		expect((await visit(app, 'https://unknown.example/launch')).status).toBe(404);
		expect((await visit(app, 'https://unknown.example/pricing')).status).toBe(404);
		expect((await visit(app, 'https://off.example/off-domain')).status).toBe(404);
		expect((await visit(app, 'https://off.example/')).status).toBe(404);
	});

	it('resolves a tenant domain only for that tenant’s links and needs a routing policy', async () => {
		await addLink('owned', 'https://example.com/owned', {
			tenant: 'tenant-b',
			domain: 'dom-owned'
		});
		await addLink('foreign', 'https://example.com/foreign', { domain: 'dom-owned' });
		await addLink('no-policy', 'https://example.com/none', { tenant: 'tenant-gone' });
		const app = handler();
		expect((await visit(app, 'https://owned.example/owned')).status).toBe(302);
		expect((await visit(app, 'https://owned.example/foreign')).status).toBe(404);
		expect((await visit(app, 'https://short.example/no-policy')).status).toBe(404);
	});
});

describe('reserved paths', () => {
	it('go to the app origin and are never looked up as slugs', async () => {
		// A stored link on a reserved path must stay unreachable.
		await addLink('pricing', 'https://example.com/hijack');
		const app = handler();
		const cases = [
			['/', `${appOrigin}/`],
			['/pricing?plan=plus', `${appOrigin}/pricing?plan=plus`],
			['/app/links', `${appOrigin}/app/links`],
			['/.well-known/security.txt', `${appOrigin}/.well-known/security.txt`],
			['/robots.txt', `${appOrigin}/robots.txt`]
		];
		for (const [path, location] of cases) {
			const response = await visit(app, `https://short.example${path}`);
			expect(response.status, path).toBe(302);
			expect(response.headers.get('location'), path).toBe(location);
			expect(response.headers.get('cache-control'), path).toBe('no-store');
		}
	});
});

describe('methods', () => {
	it('answers HEAD with the GET status and no body', async () => {
		await addLink('head-link', 'https://example.com/head');
		const app = handler();
		for (const path of ['/head-link', '/missing', '/pricing']) {
			const get = await visit(app, `https://short.example${path}`);
			const head = await visit(app, `https://short.example${path}`, 'HEAD');
			expect(head.status, path).toBe(get.status);
			expect(head.headers.get('location'), path).toBe(get.headers.get('location'));
			expect(await head.text(), path).toBe('');
		}
	});

	it('refuses other methods', async () => {
		const app = handler();
		for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
			const response = await visit(app, 'https://short.example/launch', method);
			expect(response.status, method).toBe(405);
			expect(response.headers.get('allow'), method).toBe('GET, HEAD');
		}
	});
});

describe('snapshot bound', () => {
	it('shows an edit and a disable once the 60-second deadline passes', async () => {
		await addLink('edited', 'https://example.com/old');
		await addLink('disabled', 'https://example.com/live');
		let clock = start;
		const app = handler({ now: () => clock });
		await visit(app, 'https://short.example/edited');
		await visit(app, 'https://short.example/disabled');
		await setLink('edited', { destination: 'https://example.com/new' });
		await setLink('disabled', { status: 'disabled' });

		clock = start + snapshotLifetimeMs - 1;
		const early = await visit(app, 'https://short.example/edited');
		expect(early.headers.get('location')).toBe('https://example.com/old');
		expect((await visit(app, 'https://short.example/disabled')).status).toBe(302);

		clock = start + snapshotLifetimeMs;
		const late = await visit(app, 'https://short.example/edited');
		expect(late.headers.get('location')).toBe('https://example.com/new');
		expect((await visit(app, 'https://short.example/disabled')).status).toBe(404);
	});

	it('does not extend the deadline on a cache hit', async () => {
		await addLink('hit-twice', 'https://example.com/first');
		let clock = start;
		const app = handler({ now: () => clock });
		await visit(app, 'https://short.example/hit-twice');
		clock = start + 30000;
		await visit(app, 'https://short.example/hit-twice');
		await setLink('hit-twice', { destination: 'https://example.com/second' });
		clock = start + snapshotLifetimeMs;
		const response = await visit(app, 'https://short.example/hit-twice');
		expect(response.headers.get('location')).toBe('https://example.com/second');
	});

	it('counts the deadline from the query start, so a slow fill is not used or stored', async () => {
		await addLink('slow', 'https://example.com/slow');
		const cacheName = `redirect-slow-${cacheCounter}`;
		// The lookup starts at `start` and finishes at the deadline.
		const times = [start, start + snapshotLifetimeMs];
		const slow = handler({ cacheName, now: () => times.shift() ?? start + snapshotLifetimeMs });
		expect((await visit(slow, 'https://short.example/slow')).status).toBe(503);

		const broken = handler({ cacheName, db: env.BROKEN_ROUTING });
		expect((await visit(broken, 'https://short.example/slow')).status).toBe(503);
	});

	it('serves a valid snapshot while the database fails, and 503 on a miss', async () => {
		await addLink('outage', 'https://example.com/outage');
		const cacheName = `redirect-outage-${cacheCounter}`;
		await visit(handler({ cacheName }), 'https://short.example/outage');

		const brokenWithSnapshot = handler({ cacheName, db: env.BROKEN_ROUTING });
		const served = await visit(brokenWithSnapshot, 'https://short.example/outage');
		expect(served.status).toBe(302);
		expect(served.headers.get('location')).toBe('https://example.com/outage');

		const expired = handler({
			cacheName,
			db: env.BROKEN_ROUTING,
			now: () => start + snapshotLifetimeMs
		});
		expect((await visit(expired, 'https://short.example/outage')).status).toBe(503);
		const miss = handler({ db: env.BROKEN_ROUTING });
		expect((await visit(miss, 'https://short.example/launch')).status).toBe(503);
		expect((await visit(miss, 'https://short.example/pricing')).status).toBe(503);
	});
});
