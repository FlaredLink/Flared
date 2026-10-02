// SPDX-License-Identifier: AGPL-3.0-only
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ClickEvent } from '../packages/contracts/src/analytics';
import { deviceCategory, isAutomated } from '../packages/server/src/clicks';
import {
	createRedirectHandler,
	snapshotLifetimeMs,
	type ClickSink
} from '../packages/server/src/redirect';

const appOrigin = 'https://app.example';
const routing = () => env.REDIRECT_ROUTING;
const start = Date.UTC(2026, 9, 2);

// Each handler gets its own cache, so snapshots never leak between tests.
let cacheCounter = 0;
function handler(
	options: { now?: () => number; db?: D1Database; cacheName?: string; clicks?: ClickSink } = {}
) {
	cacheCounter += 1;
	return createRedirectHandler({
		routing: options.db ?? routing(),
		appOrigin,
		cacheName: options.cacheName ?? `redirect-test-${cacheCounter}`,
		clicks: options.clicks,
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

const browser =
	'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

function recorder() {
	const events: ClickEvent[] = [];
	return { events, sink: { send: async (event: ClickEvent) => void events.push(event) } };
}

function browse(
	app: ReturnType<typeof handler>,
	url: string,
	headers: Record<string, string> = { 'user-agent': browser },
	method = 'GET'
) {
	return app.fetch(new Request(url, { method, headers, redirect: 'manual' }));
}

describe('click events', () => {
	it('sends one minimized event for a counted GET, also on a cache hit', async () => {
		await addLink('counted', 'https://example.com/private-destination?token=secret');
		const { events, sink } = recorder();
		const app = handler({ clicks: sink });
		const headers = {
			'user-agent': browser,
			referer: 'https://www.news.example/story?id=1',
			'cf-connecting-ip': '192.0.2.1'
		};
		expect((await browse(app, 'https://short.example/counted?utm=x', headers)).status).toBe(302);
		expect((await browse(app, 'https://short.example/counted', headers)).status).toBe(302);
		expect(events).toHaveLength(2);
		const [event] = events;
		expect(Object.keys(event).sort()).toEqual([
			'analyticsShardId',
			'country',
			'deviceCategory',
			'eventId',
			'kind',
			'linkId',
			'occurredAt',
			'referrerHostname',
			'schemaVersion',
			'tenantId'
		]);
		expect(event).toMatchObject({
			schemaVersion: 1,
			tenantId: 'tenant-a',
			analyticsShardId: 'analytics-1',
			kind: 'production',
			occurredAt: start,
			country: 'unknown',
			deviceCategory: 'mobile',
			referrerHostname: 'news.example'
		});
		expect(events[1].eventId).not.toBe(event.eventId);
		expect(JSON.stringify(events)).not.toMatch(/secret|192\.0\.2\.1|story|iPhone/);
	});

	it('sends nothing for HEAD, bots, reserved paths, 404, and 405', async () => {
		await addLink('quiet', 'https://example.com/quiet');
		const { events, sink } = recorder();
		const app = handler({ clicks: sink });
		await browse(app, 'https://short.example/quiet', { 'user-agent': browser }, 'HEAD');
		await browse(app, 'https://short.example/quiet', {
			'user-agent': 'Slackbot-LinkExpanding 1.0'
		});
		await browse(app, 'https://short.example/quiet', { 'user-agent': 'curl/8.7.1' });
		await browse(app, 'https://short.example/quiet', {});
		await browse(app, 'https://short.example/pricing');
		await browse(app, 'https://short.example/missing');
		await browse(app, 'https://short.example/quiet', { 'user-agent': browser }, 'POST');
		expect(events).toHaveLength(0);
	});

	it('still redirects when the Queue fails', async () => {
		await addLink('queue-down', 'https://example.com/up');
		const app = handler({
			clicks: {
				send: async () => {
					throw new Error('queue unavailable');
				}
			}
		});
		const response = await browse(app, 'https://short.example/queue-down');
		expect(response.status).toBe(302);
		expect(response.headers.get('location')).toBe('https://example.com/up');
	});
});

describe('automation classifier', () => {
	it('excludes crawlers, link previews, and HTTP libraries', () => {
		for (const agent of [
			'',
			'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
			'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
			'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
			'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)',
			'Twitterbot/1.0',
			'LinkedInBot/1.0 (compatible; Mozilla/5.0)',
			'WhatsApp/2.23.20.0 A',
			'TelegramBot (like TwitterBot)',
			'curl/8.7.1',
			'python-requests/2.32.3',
			'Go-http-client/2.0',
			'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0 Safari/537.36'
		])
			expect(isAutomated(agent), agent).toBe(true);
	});

	it('counts browsers, including in-app browsers and a CUBOT phone', () => {
		for (const agent of [
			browser,
			'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36',
			'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/470.0]',
			'Mozilla/5.0 (Linux; Android 10; CUBOT X30) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36'
		])
			expect(isAutomated(agent), agent).toBe(false);
	});

	it('maps user agents to a coarse device category', () => {
		expect(deviceCategory(browser)).toBe('mobile');
		expect(
			deviceCategory(
				'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 Chrome/129.0 Safari/537.36'
			)
		).toBe('tablet');
		expect(deviceCategory('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) Safari/605.1.15')).toBe(
			'desktop'
		);
		expect(deviceCategory('Something else')).toBe('unknown');
	});
});
