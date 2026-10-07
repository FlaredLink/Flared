// SPDX-License-Identifier: AGPL-3.0-only
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { iconHostname, iconHostnameOfUrl } from '../packages/contracts/src/icons';
import { createTenant } from '../packages/data/src/tenancy';
import { createApi } from '../packages/server/src/api';
import { projectPolicy } from '../packages/server/src/tenancy';
import {
	cacheIconStore,
	fetchIcon,
	iconFreshMs,
	iconLinks,
	iconMaxBytes,
	iconMissingMs,
	r2IconStore,
	resolveIcon,
	sniffIcon,
	type Fetcher,
	type IconBucket,
	type IconStore,
	type StoredIcon
} from '../packages/server/src/icons';

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const ico = new Uint8Array([0, 0, 1, 0, 1, 0, 16, 16]);
const svg = new TextEncoder().encode(
	'<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>'
);
const now = Date.UTC(2026, 9, 8, 12);

type Route = Response | (() => Response);
// A fake network: a map of URL to response, and the list of URLs it was asked for.
function network(routes: Record<string, Route>) {
	const calls: string[] = [];
	const fetcher: Fetcher = async (input, init) => {
		calls.push(input);
		expect(init.redirect).toBe('manual');
		const route = routes[input];
		if (!route) return new Response('not found', { status: 404 });
		return typeof route === 'function' ? route() : route.clone();
	};
	return { calls, fetcher };
}

const image = (bytes: Uint8Array, type = 'image/png') =>
	new Response(bytes, { headers: { 'content-type': type } });
const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });
const page = (html: string) => new Response(html, { headers: { 'content-type': 'text/html' } });

function memoryStore(initial: Record<string, StoredIcon> = {}): IconStore & {
	items: Map<string, StoredIcon>;
} {
	const items = new Map(Object.entries(initial));
	return {
		items,
		async get(hostname) {
			return items.get(hostname) ?? null;
		},
		async put(hostname, icon) {
			items.set(hostname, icon);
		}
	};
}

describe('icon host names', () => {
	it('keeps public DNS names and drops www', () => {
		expect(iconHostname('WWW.GitHub.com.')).toBe('github.com');
		expect(iconHostname('news.ycombinator.com')).toBe('news.ycombinator.com');
		expect(iconHostname('bücher.de')).toBe('xn--bcher-kva.de');
		expect(iconHostnameOfUrl('https://www.notion.so/page?x=1')).toBe('notion.so');
		expect(iconHostnameOfUrl('mailto:a@example.com')).toBeNull();
	});

	it('refuses IP addresses, single labels, reserved suffixes, and ports', () => {
		for (const value of [
			'127.0.0.1',
			'10.0.0.8',
			'[::1]',
			'localhost',
			'printer',
			'router.local',
			'db.internal',
			'host.home.arpa',
			'example.com:8443',
			'user@example.com',
			'a/b.com',
			''
		])
			expect(iconHostname(value), value).toBeNull();
	});
});

describe('icon fetch', () => {
	it('recognizes images by their bytes and refuses HTML', () => {
		expect(sniffIcon(png)).toBe('image/png');
		expect(sniffIcon(ico)).toBe('image/x-icon');
		expect(sniffIcon(svg)).toBe('image/svg+xml');
		expect(sniffIcon(new TextEncoder().encode('<?xml version="1.0"?>\n<svg></svg>'))).toBe(
			'image/svg+xml'
		);
		expect(sniffIcon(new TextEncoder().encode('<!doctype html><html></html>'))).toBeNull();
	});

	it('reads icon links in the order a browser tries them', () => {
		expect(
			iconLinks(
				`<link rel="apple-touch-icon" href="/touch.png"><link rel='shortcut icon' href='/a.ico'><link href=/b.svg rel="icon">`
			)
		).toEqual(['/a.ico', '/b.svg', '/touch.png']);
	});

	it('takes /favicon.ico, whatever type the server claims', async () => {
		const { fetcher, calls } = network({
			'https://site.example.com/favicon.ico': image(ico, 'text/plain')
		});
		expect(await fetchIcon('site.example.com', fetcher, now)).toEqual({
			status: 'found',
			type: 'image/x-icon',
			body: ico,
			fetchedAt: now
		});
		expect(calls).toEqual(['https://site.example.com/favicon.ico']);
	});

	it('falls back to the icon link of the home page', async () => {
		const { fetcher } = network({
			'https://site.example.com/favicon.ico': page('<html>soft 404</html>'),
			'https://site.example.com/': page('<link rel="icon" href="/static/icon.png?v=1&amp;x=2">'),
			'https://site.example.com/static/icon.png?v=1&x=2': image(png)
		});
		expect(await fetchIcon('site.example.com', fetcher, now)).toMatchObject({
			status: 'found',
			type: 'image/png'
		});
	});

	it('follows HTTPS redirects to public hosts only, at most three', async () => {
		const ok = network({
			'https://site.example.com/favicon.ico': redirect('https://cdn.example.net/f.ico'),
			'https://cdn.example.net/f.ico': image(ico)
		});
		expect((await fetchIcon('site.example.com', ok.fetcher, now)).status).toBe('found');
		for (const location of [
			'http://cdn.example.net/f.ico',
			'https://127.0.0.1/f.ico',
			'https://localhost/f.ico',
			'https://cdn.example.net:8443/f.ico'
		]) {
			const blocked = network({
				'https://site.example.com/favicon.ico': redirect(location),
				[location]: image(ico)
			});
			expect((await fetchIcon('site.example.com', blocked.fetcher, now)).status, location).toBe(
				'missing'
			);
			expect(blocked.calls).not.toContain(location);
		}
		const loop = network({
			'https://site.example.com/favicon.ico': redirect('https://a.example.com/1'),
			'https://a.example.com/1': redirect('https://a.example.com/2'),
			'https://a.example.com/2': redirect('https://a.example.com/3'),
			'https://a.example.com/3': redirect('https://a.example.com/4'),
			'https://a.example.com/4': image(ico)
		});
		expect((await fetchIcon('site.example.com', loop.fetcher, now)).status).toBe('missing');
		expect(loop.calls).not.toContain('https://a.example.com/4');
	});

	it('reads the start of a large home page for its icon links', async () => {
		const html = `<head><link rel="icon" href="/i.png"></head>${'x'.repeat(iconMaxBytes * 2)}`;
		const { fetcher } = network({
			'https://big.example.com/': new Response(html, {
				headers: { 'content-type': 'text/html', 'content-length': String(html.length) }
			}),
			'https://big.example.com/i.png': image(png)
		});
		expect((await fetchIcon('big.example.com', fetcher, now)).status).toBe('found');
	});

	it('refuses bodies over the size limit, declared or streamed', async () => {
		const big = new Uint8Array(iconMaxBytes + 1);
		big.set(png);
		const declared = network({
			'https://site.example.com/favicon.ico': new Response(big, {
				headers: { 'content-length': String(big.byteLength) }
			})
		});
		expect((await fetchIcon('site.example.com', declared.fetcher, now)).status).toBe('missing');
		const streamed = network({
			'https://site.example.com/favicon.ico': () =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(big.slice(0, 60000));
							controller.enqueue(big.slice(60000));
							controller.close();
						}
					})
				)
		});
		expect((await fetchIcon('site.example.com', streamed.fetcher, now)).status).toBe('missing');
	});

	it('tries the www name when the bare name cannot be reached', async () => {
		const asked: string[] = [];
		const fetcher: Fetcher = async (input) => {
			asked.push(input);
			if (input.startsWith('https://broadcaster.example.jp/'))
				throw new TypeError('getaddrinfo ENOTFOUND');
			return input === 'https://www.broadcaster.example.jp/favicon.ico'
				? image(ico)
				: new Response('missing', { status: 404 });
		};
		expect((await fetchIcon('broadcaster.example.jp', fetcher, now)).status).toBe('found');
		expect(asked).toEqual([
			'https://broadcaster.example.jp/favicon.ico',
			'https://www.broadcaster.example.jp/favicon.ico'
		]);
		// A host that answered, even with a redirect, is not asked again under www.
		const redirected: string[] = [];
		const timing: Fetcher = async (input) => {
			redirected.push(input);
			if (input === 'https://slow.example.com/favicon.ico')
				return redirect('https://www.slow.example.com/favicon.ico');
			throw new DOMException('The operation timed out.', 'TimeoutError');
		};
		expect((await fetchIcon('slow.example.com', timing, now)).status).toBe('missing');
		expect(redirected).toEqual([
			'https://slow.example.com/favicon.ico',
			'https://www.slow.example.com/favicon.ico'
		]);
		// A site that answers without an icon is not asked again under www.
		const answered = network({});
		expect((await fetchIcon('site.example.com', answered.fetcher, now)).status).toBe('missing');
		expect(answered.calls.some((url) => url.includes('www.'))).toBe(false);
	});

	it('records a missing icon when the site fails or times out', async () => {
		const failing: Fetcher = async () => {
			throw new DOMException('The operation timed out.', 'TimeoutError');
		};
		expect(await fetchIcon('site.example.com', failing, now)).toEqual({
			status: 'missing',
			fetchedAt: now
		});
	});
});

describe('icon cache', () => {
	const found: StoredIcon = { status: 'found', type: 'image/png', body: png, fetchedAt: now };

	it('uses a fresh record without asking the site', async () => {
		const { fetcher, calls } = network({});
		const store = memoryStore({ 'a.example.com': found });
		expect(await resolveIcon(store, 'a.example.com', fetcher, now + iconFreshMs - 1)).toEqual(
			found
		);
		const missing = memoryStore({ 'b.example.com': { status: 'missing', fetchedAt: now } });
		expect(
			(await resolveIcon(missing, 'b.example.com', fetcher, now + iconMissingMs - 1))?.status
		).toBe('missing');
		expect(calls).toEqual([]);
	});

	it('asks again after the lifetime and keeps a found icon when the site has none', async () => {
		const { fetcher, calls } = network({});
		const store = memoryStore({ 'a.example.com': found });
		const later = now + iconFreshMs;
		expect(await resolveIcon(store, 'a.example.com', fetcher, later)).toEqual({
			...found,
			fetchedAt: later
		});
		expect(calls).toContain('https://a.example.com/favicon.ico');
		const missing = memoryStore({ 'b.example.com': { status: 'missing', fetchedAt: now } });
		const icon = network({ 'https://b.example.com/favicon.ico': image(png) });
		expect(
			(await resolveIcon(missing, 'b.example.com', icon.fetcher, now + iconMissingMs))?.status
		).toBe('found');
	});

	it('does not fetch when the budget is spent, and serves what it has', async () => {
		const { fetcher, calls } = network({ 'https://a.example.com/favicon.ico': image(png) });
		const store = memoryStore({ 'a.example.com': found });
		const stale = now + iconFreshMs;
		expect(await resolveIcon(store, 'a.example.com', fetcher, stale, async () => false)).toEqual(
			found
		);
		expect(await resolveIcon(store, 'new.example.com', fetcher, now, async () => false)).toBeNull();
		expect(calls).toEqual([]);
		expect(store.items.has('new.example.com')).toBe(false);
	});

	it('keeps records in R2 objects and in the Workers cache', async () => {
		const objects = new Map<string, { body: Uint8Array; meta: Record<string, string> }>();
		const bucket: IconBucket = {
			async get(key) {
				const object = objects.get(key);
				return object
					? {
							customMetadata: object.meta,
							arrayBuffer: async () => object.body.slice().buffer
						}
					: null;
			},
			async put(key, value, options) {
				objects.set(key, { body: value, meta: options.customMetadata });
			}
		};
		const cache = await caches.open(`icons-test-${crypto.randomUUID()}`);
		for (const store of [r2IconStore(bucket), cacheIconStore(cache)]) {
			await store.put('a.example.com', found);
			await store.put('b.example.com', { status: 'missing', fetchedAt: now });
			expect(await store.get('a.example.com')).toEqual(found);
			expect(await store.get('b.example.com')).toEqual({ status: 'missing', fetchedAt: now });
			expect(await store.get('c.example.com')).toBeNull();
		}
		objects.set('icons/v1/d.example.com', {
			body: png,
			meta: { status: 'found', type: 'text/html', fetchedAt: String(now) }
		});
		expect(await r2IconStore(bucket).get('d.example.com')).toBeNull();
	});
});

describe('icon route', () => {
	const identity = () => env.ICONS_IDENTITY;
	const routing = () => env.ICONS_ROUTING;
	const origin = 'https://app.example';

	beforeAll(async () => {
		await applyD1Migrations(identity(), env.IDENTITY_MIGRATIONS, 'flared_core_migrations');
		await applyD1Migrations(routing(), env.ROUTING_MIGRATIONS, 'flared_core_migrations');
		await applyD1Migrations(
			env.ICONS_ANALYTICS,
			env.ANALYTICS_MIGRATIONS,
			'flared_core_migrations'
		);
		await identity()
			.prepare("INSERT INTO installation (id, mode, created_at) VALUES (1, 'multi', 0)")
			.run();
		await identity()
			.prepare(
				"INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('icon-user', '', 'icon-user@example.com', 1, 0, 0)"
			)
			.run();
		await createTenant(identity(), {
			id: 'icon-tenant',
			name: 'Workspace',
			ownerUserId: 'icon-user',
			analyticsShardId: 'analytics-1',
			limits: { activeLinkLimit: 10, monthlyClickLimit: 5000, retentionDays: 30, domainLimit: 1 },
			now: 1
		});
		await projectPolicy(
			identity(),
			{ routing: routing(), analytics: { 'analytics-1': env.ICONS_ANALYTICS } },
			'icon-tenant',
			1
		);
	});

	const api = (icons: Parameters<typeof createApi>[0]['icons'], kind = 'session', clock = now) =>
		createApi({
			identity: identity(),
			routing: routing(),
			appOrigin: origin,
			authenticate: async () =>
				kind === 'session'
					? { kind: 'session', userId: 'icon-user', signedInAt: new Date(now).toISOString() }
					: {
							kind: 'oauth',
							userId: 'icon-user',
							tenantId: 'icon-tenant',
							scopes: ['links:read'],
							clientId: 'client-1'
						},
			now: () => clock,
			icons
		});
	const get = (app: ReturnType<typeof createApi>, hostname: string) =>
		app.fetch(new Request(`${origin}/v1/icons/${hostname}`));

	it('serves a stored or fetched icon to a session, with a sandbox for SVG', async () => {
		const { fetcher } = network({
			'https://svg.example.com/favicon.ico': image(svg, 'image/svg+xml')
		});
		const store = memoryStore({
			'png.example.com': { status: 'found', type: 'image/png', body: png, fetchedAt: now }
		});
		const app = api({ store, fetch: fetcher });
		const stored = await get(app, 'www.png.example.com');
		expect(stored.status).toBe(200);
		expect(stored.headers.get('content-type')).toBe('image/png');
		expect(new Uint8Array(await stored.arrayBuffer())).toEqual(png);
		const fetched = await get(app, 'svg.example.com');
		expect(fetched.headers.get('content-type')).toBe('image/svg+xml');
		expect(fetched.headers.get('content-security-policy')).toContain('sandbox');
		expect(fetched.headers.get('x-content-type-options')).toBe('nosniff');
	});

	it('answers 404 without a store, for a bad host name, and for a site without an icon', async () => {
		expect((await get(api(undefined), 'github.com')).status).toBe(404);
		const app = api({ store: memoryStore(), fetch: network({}).fetcher });
		expect((await get(app, '127.0.0.1')).status).toBe(404);
		const none = await get(app, 'empty.example.com');
		expect(none.status).toBe(404);
		expect(none.headers.get('cache-control')).toBe('private, max-age=86400');
	});

	it('refuses tokens and connected apps', async () => {
		const response = await get(api({ store: memoryStore() }, 'oauth'), 'github.com');
		expect(response.status).toBe(403);
	});

	it('limits fetches from sites for each workspace, never stored icons', async () => {
		const { fetcher, calls } = network({
			'https://one.example.com/favicon.ico': image(png),
			'https://two.example.com/favicon.ico': image(png)
		});
		const store = memoryStore({
			'kept.example.com': { status: 'found', type: 'image/png', body: png, fetchedAt: now }
		});
		// A later minute, so the earlier tests' fetches do not count against this budget.
		const app = api({ store, fetch: fetcher, fetchesPerMinute: 1 }, 'session', now + 10 * 60000);
		expect((await get(app, 'one.example.com')).status).toBe(200);
		const limited = await get(app, 'two.example.com');
		expect(limited.status).toBe(404);
		expect(limited.headers.get('cache-control')).toBe('private, max-age=60');
		expect(calls).not.toContain('https://two.example.com/favicon.ico');
		expect((await get(app, 'kept.example.com')).status).toBe(200);
		expect((await get(app, 'one.example.com')).status).toBe(200);
	});
});
