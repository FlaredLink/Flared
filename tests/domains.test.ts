// SPDX-License-Identifier: AGPL-3.0-only
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TokenScope } from '../packages/contracts/src/tokens';
import { domainClaimLifetimeMs } from '../packages/contracts/src/domains';
import { createTenant } from '../packages/data/src/tenancy';
import { createApi } from '../packages/server/src/api';
import {
	recordDomainEvidence,
	type DomainEvidence,
	type DomainProvider
} from '../packages/server/src/domains';
import { createRedirectHandler, snapshotLifetimeMs } from '../packages/server/src/redirect';
import { projectPolicy } from '../packages/server/src/tenancy';
import { qrMatrix, qrSvg } from '../packages/client/src/qr';

const origin = 'https://app.example';
const identity = () => env.DOMAINS_IDENTITY;
const routing = () => env.DOMAINS_ROUTING;
const start = Date.UTC(2026, 9, 3);
let clock = start;

// The next result of start or check: evidence, or an error the provider throws.
let next: DomainEvidence | Error = { status: 'waiting' };
const calls: string[] = [];
const provider: DomainProvider = {
	records: (hostname) => [{ type: 'CNAME', name: hostname, value: 'customers.example' }],
	start: async (domain) => {
		calls.push(`start ${domain.hostname}`);
		if (next instanceof Error) throw next;
		return next;
	},
	check: async (domain) => {
		calls.push(`check ${domain.hostname}`);
		if (next instanceof Error) throw next;
		return next;
	},
	stop: async (domain) => {
		calls.push(`stop ${domain.hostname}`);
	}
};

function api(options: { withProvider?: boolean } = {}) {
	return createApi({
		identity: identity(),
		routing: routing(),
		appOrigin: origin,
		domains: {
			provider: options.withProvider === false ? undefined : provider,
			reservedHostnames: ['short.example', 'brand.dev']
		},
		// Test-only principals: a session, or a token with the scopes in x-test-scopes.
		authenticate: async (request) => {
			const userId = request.headers.get('x-test-user');
			if (!userId) return null;
			const scopes = request.headers.get('x-test-scopes');
			const tenantId = request.headers.get('x-test-tenant');
			if (scopes !== null && tenantId)
				return {
					kind: 'token',
					userId,
					tenantId,
					scopes: scopes.split(' ') as TokenScope[],
					token: { id: 'token-1', name: 'Test', start: 'flr_test', expiresAt: null }
				};
			return { kind: 'session', userId, signedInAt: new Date(clock).toISOString() };
		},
		now: () => clock,
		creationsPerMinute: 1000
	});
}

function call(
	user: string,
	method: string,
	path: string,
	body?: unknown,
	headers: Record<string, string> = {},
	app = api()
) {
	const init: RequestInit = { method, headers: { origin, 'x-test-user': user, ...headers } };
	if (body !== undefined) {
		init.body = JSON.stringify(body);
		(init.headers as Record<string, string>)['content-type'] = 'application/json';
	}
	return app.fetch(new Request(`${origin}${path}`, init));
}

async function json(response: Response) {
	return (await response.json()) as Record<string, any>;
}

const add = (user: string, hostname: unknown, app = api()) =>
	call(user, 'POST', '/v1/domains', { hostname }, {}, app);

let linkKey = 0;
function createLink(user: string, body: Record<string, unknown>) {
	linkKey += 1;
	return call(user, 'POST', '/v1/links', body, { 'idempotency-key': `key-${linkKey}` });
}

let cacheCounter = 0;
function visit(url: string, accept = '*/*') {
	cacheCounter += 1;
	return createRedirectHandler({
		routing: routing(),
		appOrigin: origin,
		cacheName: `domains-test-${cacheCounter}`,
		now: () => clock
	}).fetch(new Request(url, { headers: { accept }, redirect: 'manual' }));
}

async function addTenant(userId: string, tenantId: string, domainLimit: number) {
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
		limits: { activeLinkLimit: 100, monthlyClickLimit: 5000, retentionDays: 30, domainLimit },
		now: 1
	});
	await projectPolicy(
		identity(),
		{ routing: routing(), analytics: { 'analytics-1': env.DOMAINS_ANALYTICS } },
		tenantId,
		1
	);
}

beforeAll(async () => {
	await applyD1Migrations(identity(), env.IDENTITY_MIGRATIONS, 'flared_core_migrations');
	await applyD1Migrations(routing(), env.ROUTING_MIGRATIONS, 'flared_core_migrations');
	await applyD1Migrations(
		env.DOMAINS_ANALYTICS,
		env.ANALYTICS_MIGRATIONS,
		'flared_core_migrations'
	);
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
	for (const [user, tenant, limit] of [
		['user-a', 'tenant-a', 1],
		['user-b', 'tenant-b', 1],
		['user-c', 'tenant-c', 3],
		['user-d', 'tenant-d', 3],
		['user-e', 'tenant-e', 1],
		['user-f', 'tenant-f', 1],
		['user-g', 'tenant-g', 3]
	] as const)
		await addTenant(user, tenant, limit);
});

// A new minute for each test, so the per-minute budget for adding domains starts fresh.
beforeEach(() => {
	clock += 60000;
	next = { status: 'waiting' };
	calls.length = 0;
});

describe('listing', () => {
	it('lists the platform domain with the workspace usage', async () => {
		const response = await call('user-f', 'GET', '/v1/domains');
		expect(response.status).toBe(200);
		expect(await json(response)).toEqual({
			domains: [
				{
					id: 'dom-short',
					hostname: 'short.example',
					kind: 'platform',
					state: 'active',
					isDefault: true,
					records: [],
					error: null,
					activeLinks: null,
					createdAt: new Date(0).toISOString(),
					activatedAt: null
				}
			],
			used: 0,
			limit: 1
		});
	});
});

describe('adding a domain', () => {
	it('fails closed without a provider', async () => {
		const response = await add('user-f', 'go.none.example.com', api({ withProvider: false }));
		expect(response.status).toBe(503);
		expect((await json(response)).error.code).toBe('DOMAINS_UNAVAILABLE');
	});

	it('refuses hostnames that are not a public subdomain', async () => {
		for (const hostname of [
			'example.com',
			'go.example.com:443',
			'https://go.example.com',
			'go.example.com/path',
			'*.example.com',
			'1.2.3.4',
			'go..example.com',
			'go.app.localhost',
			'-go.example.com'
		]) {
			const response = await add('user-f', hostname);
			expect(response.status, String(hostname)).toBe(422);
			expect((await json(response)).error.field, String(hostname)).toBe('hostname');
		}
		expect(calls).toEqual([]);
	});

	it('refuses empty and non-text hostnames, and limits additions per minute', async () => {
		for (const hostname of ['', '   ', 42, null]) {
			const response = await add('user-f', hostname);
			expect(response.status, String(hostname)).toBe(422);
		}
		for (let attempt = 0; attempt < 6; attempt += 1) await add('user-f', 'bad');
		const limited = await add('user-f', 'go.later.example.com');
		expect(limited.status).toBe(429);
		expect((await json(limited)).error.code).toBe('RATE_LIMITED');
	});

	it('refuses the installation’s own hostnames and their subdomains', async () => {
		for (const hostname of ['go.brand.dev', 'a.b.brand.dev']) {
			const response = await add('user-f', hostname);
			expect(response.status, hostname).toBe(409);
			expect((await json(response)).error.code).toBe('DOMAIN_TAKEN');
		}
	});

	it('normalizes the hostname, starts the provider, and returns the records', async () => {
		const response = await add('user-a', ' Go.Bücher.Example.COM. ');
		expect(response.status).toBe(201);
		const { domain } = await json(response);
		expect(domain).toMatchObject({
			hostname: 'go.xn--bcher-kva.example.com',
			kind: 'workspace',
			state: 'pending',
			isDefault: false,
			records: [
				{ type: 'CNAME', name: 'go.xn--bcher-kva.example.com', value: 'customers.example' }
			],
			error: null,
			activeLinks: 0,
			activatedAt: null
		});
		expect(calls).toEqual(['start go.xn--bcher-kva.example.com']);

		// Adding it again returns the same domain without a second start.
		const again = await add('user-a', 'go.xn--bcher-kva.example.com');
		expect(again.status).toBe(200);
		expect((await json(again)).domain.id).toBe(domain.id);
		expect(calls).toHaveLength(1);
	});

	it('enforces the domain limit and the hostname’s owner', async () => {
		const limited = await add('user-a', 'second.alpha.com');
		expect(limited.status).toBe(403);
		expect((await json(limited)).error.code).toBe('DOMAIN_LIMIT_REACHED');

		const taken = await add('user-b', 'go.xn--bcher-kva.example.com');
		expect(taken.status).toBe(409);
		expect((await json(taken)).error.code).toBe('DOMAIN_TAKEN');

		const page = await json(await call('user-a', 'GET', '/v1/domains'));
		expect(page).toMatchObject({ used: 1, limit: 1 });
	});

	it('gives a hostname to one workspace when two add it at once', async () => {
		const results = await Promise.all([
			add('user-c', 'race.example.org'),
			add('user-d', 'race.example.org')
		]);
		expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
	});

	it('holds the limit when one workspace adds two hostnames at once', async () => {
		const results = await Promise.all([
			add('user-e', 'one.example.net'),
			add('user-e', 'two.example.net')
		]);
		expect(results.map((r) => r.status).sort()).toEqual([201, 403]);
	});

	it('stores a provider fault as a failure the person can retry', async () => {
		next = new Error('provider down');
		const response = await add('user-g', 'fault.example.io');
		expect(response.status).toBe(201);
		const { domain } = await json(response);
		expect(domain.state).toBe('failed');
		expect(domain.error.code).toBe('provider_error');

		next = { status: 'verifying' };
		const checked = await call('user-g', 'POST', `/v1/domains/${domain.id}/check`);
		expect((await json(checked)).domain).toMatchObject({ state: 'verifying', error: null });
	});
});

describe('checks and routing', () => {
	it('activates on ready evidence and spaces out checks', async () => {
		const { domain } = await json(await add('user-c', 'go.check.example.com'));
		next = { status: 'ready' };
		const first = await call('user-c', 'POST', `/v1/domains/${domain.id}/check`);
		expect(first.status).toBe(200);
		const active = (await json(first)).domain;
		expect(active.state).toBe('active');
		expect(active.activatedAt).toBe(new Date(clock).toISOString());

		const soon = await call('user-c', 'POST', `/v1/domains/${domain.id}/check`);
		expect(soon.status).toBe(429);
		expect((await json(soon)).error.code).toBe('DOMAIN_CHECK_TOO_SOON');
		expect(Number(soon.headers.get('retry-after'))).toBeGreaterThan(0);

		// A renewal reported as verifying keeps an active domain active.
		clock += 61000;
		next = { status: 'verifying' };
		const renewal = await call('user-c', 'POST', `/v1/domains/${domain.id}/check`);
		expect((await json(renewal)).domain.state).toBe('active');
	});

	it('creates links only on the owner’s active domain and serves them there', async () => {
		const { domains } = await json(await call('user-c', 'GET', '/v1/domains'));
		const custom = domains.find((d: { hostname: string }) => d.hostname === 'go.check.example.com');
		const created = await createLink('user-c', {
			destination: 'https://example.com/custom',
			slug: 'custom-link',
			domainId: custom.id
		});
		expect(created.status).toBe(201);
		expect((await json(created)).link.shortUrl).toBe('https://go.check.example.com/custom-link');

		const foreign = await createLink('user-d', {
			destination: 'https://example.com/foreign',
			domainId: custom.id
		});
		expect(foreign.status).toBe(422);
		expect((await json(foreign)).error.code).toBe('DOMAIN_UNAVAILABLE');

		const redirect = await visit('https://go.check.example.com/custom-link');
		expect(redirect.status).toBe(302);
		expect(redirect.headers.get('location')).toBe('https://example.com/custom');

		// The root of a workspace domain is not a Flared page; the platform root still is.
		expect((await visit('https://go.check.example.com/')).status).toBe(404);
		expect((await visit('https://go.check.example.com/pricing')).status).toBe(404);
		expect((await visit('https://short.example/')).status).toBe(302);

		const listed = await json(await call('user-c', 'GET', `/v1/domains/${custom.id}`));
		expect(listed.domain.activeLinks).toBe(1);
	});

	it('keeps a pending domain from serving links', async () => {
		const { domain } = await json(await add('user-d', 'go.pending.example.com'));
		const created = await createLink('user-d', {
			destination: 'https://example.com/early',
			domainId: domain.id
		});
		expect(created.status).toBe(422);
	});
});

describe('isolation and scopes', () => {
	it('hides another workspace’s domain and the platform domain from changes', async () => {
		const { domains } = await json(await call('user-c', 'GET', '/v1/domains'));
		const custom = domains.find((d: { kind: string }) => d.kind === 'workspace');
		expect((await call('user-d', 'GET', `/v1/domains/${custom.id}`)).status).toBe(404);
		expect((await call('user-d', 'DELETE', `/v1/domains/${custom.id}`)).status).toBe(404);
		expect((await call('user-d', 'POST', `/v1/domains/${custom.id}/check`)).status).toBe(404);
		expect((await call('user-c', 'DELETE', '/v1/domains/dom-short')).status).toBe(404);
		expect((await call('user-c', 'POST', '/v1/domains/dom-short/check')).status).toBe(404);
		const other = await json(await call('user-d', 'GET', '/v1/domains'));
		expect(other.domains.map((d: { id: string }) => d.id)).not.toContain(custom.id);
	});

	it('needs domains:write for changes and the app origin for sessions', async () => {
		const token = { 'x-test-scopes': 'domains:read', 'x-test-tenant': 'tenant-g' };
		expect((await call('user-g', 'GET', '/v1/domains', undefined, token)).status).toBe(200);
		const refused = await call('user-g', 'POST', '/v1/domains', { hostname: 'x.y.com' }, token);
		expect(refused.status).toBe(403);
		expect((await json(refused)).error.code).toBe('INSUFFICIENT_SCOPE');

		const crossSite = await call(
			'user-g',
			'POST',
			'/v1/domains',
			{ hostname: 'x.y.com' },
			{
				origin: 'https://evil.example'
			}
		);
		expect(crossSite.status).toBe(403);
		expect((await json(crossSite)).error.code).toBe('ORIGIN_REJECTED');
	});
});

describe('removal and claims', () => {
	it('stops links at once, detaches the hostname, and restores them on a re-add', async () => {
		const { domains } = await json(await call('user-c', 'GET', '/v1/domains'));
		const custom = domains.find((d: { hostname: string }) => d.hostname === 'go.check.example.com');
		const removed = await call('user-c', 'DELETE', `/v1/domains/${custom.id}`);
		expect(removed.status).toBe(204);
		expect(calls).toEqual(['stop go.check.example.com']);
		expect((await visit('https://go.check.example.com/custom-link')).status).toBe(404);
		const after = await json(await call('user-c', 'GET', '/v1/domains'));
		expect(after.domains.map((d: { id: string }) => d.id)).not.toContain(custom.id);

		next = { status: 'ready' };
		const readded = await add('user-c', 'go.check.example.com');
		expect(readded.status).toBe(201);
		const { domain } = await json(readded);
		expect(domain).toMatchObject({ id: custom.id, state: 'active', activeLinks: 1 });
		expect((await visit('https://go.check.example.com/custom-link')).status).toBe(302);

		// The slug stays reserved on the hostname.
		const reuse = await createLink('user-c', {
			destination: 'https://example.com/other',
			slug: 'custom-link',
			domainId: custom.id
		});
		expect(reuse.status).toBe(409);
	});

	it('releases an unverified claim after 7 days and ignores evidence for the old claim', async () => {
		const { domain: first } = await json(await add('user-f', 'go.squat.example.com'));
		const oldClaim = { id: first.id, hostname: first.hostname, claimedAt: clock };
		expect((await add('user-b', 'go.squat.example.com')).status).toBe(409);

		clock += domainClaimLifetimeMs;
		const shown = await json(await call('user-f', 'GET', `/v1/domains/${first.id}`));
		expect(shown.domain).toMatchObject({ state: 'failed', error: { code: 'expired' } });

		const taken = await add('user-b', 'go.squat.example.com');
		expect(taken.status).toBe(201);
		expect((await call('user-f', 'GET', `/v1/domains/${first.id}`)).status).toBe(404);

		await recordDomainEvidence(routing(), oldClaim, { status: 'ready' }, clock);
		const current = await json(await call('user-b', 'GET', `/v1/domains/${first.id}`));
		expect(current.domain.state).toBe('pending');
	});

	it('never releases an active domain', async () => {
		next = { status: 'ready' };
		const { domain } = await json(await add('user-d', 'go.kept.example.com'));
		expect(domain.state).toBe('active');
		clock += domainClaimLifetimeMs * 2;
		expect((await add('user-e', 'go.kept.example.com')).status).toBe(409);
	});

	it('never changes a removed domain through evidence', async () => {
		const { domain } = await json(await add('user-g', 'go.gone.example.com'));
		const claim = { id: domain.id, hostname: domain.hostname, claimedAt: clock };
		await call('user-g', 'DELETE', `/v1/domains/${domain.id}`);
		await recordDomainEvidence(routing(), claim, { status: 'ready' }, clock);
		const row = await routing()
			.prepare('SELECT state FROM domains WHERE id = ?')
			.bind(domain.id)
			.first<{ state: string }>();
		expect(row?.state).toBe('disabled');
		expect((await visit('https://go.gone.example.com/abc')).status).toBe(404);
	});

	it('stops a removed domain’s links within the snapshot bound', async () => {
		next = { status: 'ready' };
		const { domain } = await json(await add('user-g', 'go.cached.example.com'));
		await createLink('user-g', {
			destination: 'https://example.com/cached',
			slug: 'cached',
			domainId: domain.id
		});
		const handler = createRedirectHandler({
			routing: routing(),
			appOrigin: origin,
			cacheName: 'domains-snapshot',
			now: () => clock
		});
		const open = () =>
			handler.fetch(new Request('https://go.cached.example.com/cached', { redirect: 'manual' }));
		expect((await open()).status).toBe(302);
		await call('user-g', 'DELETE', `/v1/domains/${domain.id}`);
		clock += snapshotLifetimeMs;
		expect((await open()).status).toBe(404);
	});
});

describe('QR codes', () => {
	let linkId = '';
	let shortUrl = '';
	beforeAll(async () => {
		const created = await json(
			await createLink('user-f', { destination: 'https://example.com/qr', slug: 'qr-code' })
		);
		linkId = created.link.id;
		shortUrl = created.link.shortUrl;
	});

	it('serves an SVG of the short URL', async () => {
		const response = await call('user-f', 'GET', `/v1/links/${linkId}/qr`);
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('image/svg+xml');
		expect(response.headers.get('cache-control')).toBe('private, max-age=86400');
		const body = await response.text();
		expect(body).toBe(qrSvg(shortUrl, 512));
		expect(body).not.toMatch(/script|example\.com\/qr/i);
	});

	it('serves a PNG whose pixels match the code of the short URL', async () => {
		const response = await call('user-f', 'GET', `/v1/links/${linkId}/qr?format=png&size=300`);
		expect(response.headers.get('content-type')).toBe('image/png');
		const png = new Uint8Array(await response.arrayBuffer());
		expect([...png.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		const view = new DataView(png.buffer);
		const width = view.getUint32(16);
		expect(width).toBe(300);
		const pixels = await decodePng(png, width);
		const code = qrMatrix(shortUrl);
		const scale = Math.floor(300 / (code.size + 8));
		const offset = Math.floor((width - code.size * scale) / 2);
		for (let y = 0; y < code.size; y += 1)
			for (let x = 0; x < code.size; x += 1)
				expect(pixels(offset + x * scale, offset + y * scale), `${x},${y}`).toBe(code.get(x, y));
		expect(pixels(0, 0)).toBe(false);
	});

	it('adds a file name on download and checks its options', async () => {
		const download = await call('user-f', 'GET', `/v1/links/${linkId}/qr?format=png&download=1`);
		expect(download.headers.get('content-disposition')).toBe('attachment; filename="qr-code.png"');
		for (const query of ['format=gif', 'size=100', 'size=4096', 'size=abc']) {
			const response = await call('user-f', 'GET', `/v1/links/${linkId}/qr?${query}`);
			expect(response.status, query).toBe(422);
		}
	});

	it('hides another workspace’s link', async () => {
		expect((await call('user-g', 'GET', `/v1/links/${linkId}/qr`)).status).toBe(404);
	});
});

// Reads a 1-bit grayscale PNG from qrPng; true means a dark pixel.
async function decodePng(png: Uint8Array, width: number) {
	const view = new DataView(png.buffer);
	const parts: Uint8Array[] = [];
	for (let at = 8; at < png.length;) {
		const length = view.getUint32(at);
		const type = new TextDecoder().decode(png.slice(at + 4, at + 8));
		if (type === 'IDAT') parts.push(png.slice(at + 8, at + 8 + length));
		at += 12 + length;
	}
	const stream = new Blob(parts).stream().pipeThrough(new DecompressionStream('deflate'));
	const raw = new Uint8Array(await new Response(stream).arrayBuffer());
	const rowBytes = Math.ceil(width / 8) + 1;
	return (x: number, y: number) => (raw[y * rowBytes + 1 + (x >> 3)] & (0x80 >> (x & 7))) === 0;
}
