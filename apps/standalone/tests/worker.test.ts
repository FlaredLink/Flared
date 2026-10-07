// SPDX-License-Identifier: AGPL-3.0-only
// The standalone Worker entry against real D1: the configuration gate, the setup gate, host
// routing, credential separation between the session API, the token API, and MCP, the limits
// route, an app host move, the scheduled jobs, the click Queue, and the closed installation.
import { env } from 'cloudflare:workers';
import {
	applyD1Migrations,
	createExecutionContext,
	createMessageBatch,
	createScheduledController,
	getQueueResult,
	waitOnExecutionContext
} from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ClickEvent } from '@flared/contracts/analytics';
import { routeSettleMs, runDeletions } from '@flared/server/deletion';
import worker, { type StandaloneEnv } from '../worker/index';
import { calls } from './sveltekit-worker.stub';

const origin = 'https://flared.example.workers.dev';
const movedOrigin = 'https://links.example.com';
const password = 'correct horse battery';
const setupSecret = 'test-only-setup-secret-with-at-least-32-bytes';
const sent: ClickEvent[] = [];

function baseEnv(change: Partial<StandaloneEnv> = {}): StandaloneEnv {
	return {
		ASSETS: { fetch: async () => new Response('asset') },
		IDENTITY: env.IDENTITY,
		ROUTING: env.ROUTING,
		ANALYTICS_1: env.ANALYTICS_1,
		CLICKS: {
			async send(event) {
				sent.push(event);
			}
		},
		APP_ORIGIN: origin,
		AUTH_SECRET: 'test-only-auth-secret-at-least-thirty-two-characters',
		SETUP_SECRET: setupSecret,
		...change
	};
}

async function call(
	url: string,
	init: RequestInit<IncomingRequestCfProperties> = {},
	change: Partial<StandaloneEnv> = {}
): Promise<Response> {
	const ctx = createExecutionContext();
	const request = new Request<unknown, IncomingRequestCfProperties>(url, init);
	const response = await worker.fetch(request, baseEnv(change), ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

function cookieOf(response: Response): string {
	return response.headers
		.getSetCookie()
		.map((cookie) => cookie.split(';')[0])
		.filter((pair) => pair.includes('session_token='))
		.join('; ');
}

async function code(response: Response): Promise<string | undefined> {
	const body = (await response.clone().json()) as { error?: { code?: string } };
	return body.error?.code;
}

async function count(sql: string): Promise<number> {
	return (await env.IDENTITY.prepare(sql).first<{ n: number }>())?.n ?? -1;
}

const browser = (cookie: string, extra: Record<string, string> = {}) => ({
	cookie,
	origin,
	'content-type': 'application/json',
	'cf-connecting-ip': '198.51.100.7',
	...extra
});

let owner = '';
let linkId = '';
let token = '';

beforeAll(async () => {
	await applyD1Migrations(env.IDENTITY, env.IDENTITY_MIGRATIONS);
	await applyD1Migrations(env.ROUTING, env.ROUTING_MIGRATIONS);
	await applyD1Migrations(env.ANALYTICS_1, env.ANALYTICS_MIGRATIONS);
});

describe('configuration gate', () => {
	it('names a missing or invalid secret and suggests the address only', async () => {
		for (const value of [undefined, 'https://flared.example.workers.dev/app', 'http://x.example']) {
			const response = await call('https://seen.example/app', {}, { APP_ORIGIN: value });
			expect(response.status).toBe(503);
			const text = await response.text();
			expect(text).toContain('APP_ORIGIN');
			expect(text).toContain('https://seen.example');
			expect(text).not.toContain(setupSecret);
		}
		const short = await call(`${origin}/app`, {}, { AUTH_SECRET: 'short' });
		expect(await short.text()).toContain('AUTH_SECRET');
	});
});

describe('before setup', () => {
	it('serves only setup, its assets, and health', async () => {
		calls.length = 0;
		const app = await call(`${origin}/app/settings`);
		expect(app.status).toBe(303);
		expect(app.headers.get('location')).toBe(`${origin}/setup`);
		expect(await code(await call(`${origin}/api/v1/links`))).toBe('SETUP_REQUIRED');
		expect(await code(await call(`${origin}/v1/links`))).toBe('SETUP_REQUIRED');
		expect((await call(`${origin}/setup`)).status).toBe(200);
		expect(calls.at(-1)?.env.INSTALLATION).toEqual({ state: 'unclaimed', moving: false });
		expect((await call(`${origin}/healthz`)).status).toBe(503);
	});

	it('takes the client address only from Cloudflare, then sets up and signs in', async () => {
		const body = JSON.stringify({
			secret: setupSecret,
			username: 'owner',
			password,
			workspaceName: 'Links'
		});
		const spoofed = await call(`${origin}/api/setup`, {
			method: 'POST',
			headers: { origin, 'content-type': 'application/json', 'x-flared-source': '203.0.113.1' },
			body
		});
		expect(await code(spoofed)).toBe('SETUP_UNAVAILABLE');
		const created = await call(`${origin}/api/setup`, {
			method: 'POST',
			headers: browser(''),
			body
		});
		expect(created.status).toBe(200);
		owner = cookieOf(created);
		expect(owner).toContain('session_token=');
	});
});

describe('the app host after setup', () => {
	it('sends reserved paths to the app and other paths to short links', async () => {
		calls.length = 0;
		for (const path of ['/', '/app', '/setup', '/app/settings'])
			expect(await (await call(`${origin}${path}`)).text(), path).toBe('sveltekit');
		expect(calls).toHaveLength(4);
		const missing = await call(`${origin}/no-such-link`);
		expect(missing.status).toBe(404);
		expect(calls).toHaveLength(4);
		const session = await call(`${origin}/api/auth/session`, { headers: { cookie: owner } });
		expect(((await session.json()) as { user: { name: string } }).user.name).toBe('owner');
	});

	it('checks Origin on the session API and redirects a new link with a click', async () => {
		const body = JSON.stringify({ destination: 'https://example.com/landing', slug: 'first-link' });
		const create = (headers: Record<string, string>) =>
			call(`${origin}/api/v1/links`, {
				method: 'POST',
				headers: { cookie: owner, 'content-type': 'application/json', ...headers },
				body
			});
		expect(await code(await create({ 'idempotency-key': crypto.randomUUID() }))).toBe(
			'ORIGIN_REJECTED'
		);
		for (const bad of ['null', 'https://evil.example'])
			expect(
				await code(await create({ origin: bad, 'idempotency-key': crypto.randomUUID() }))
			).toBe('ORIGIN_REJECTED');
		const created = await create({ origin, 'idempotency-key': crypto.randomUUID() });
		expect(created.status).toBe(201);
		const { link } = (await created.json()) as { link: { id: string; shortUrl: string } };
		linkId = link.id;
		expect(link.shortUrl).toBe(`${origin}/first-link`);
		const visit = await call(`${origin}/first-link`, {
			headers: { 'user-agent': 'Mozilla/5.0 (Macintosh) Safari/605.1.15' }
		});
		expect(visit.status).toBe(302);
		expect(visit.headers.get('location')).toBe('https://example.com/landing');
		expect(sent).toHaveLength(1);
	});

	it('keeps cookies and tokens apart: /api/v1 sessions, /v1 tokens, MCP OAuth', async () => {
		const created = await call(`${origin}/api/v1/tokens`, {
			method: 'POST',
			headers: browser(owner),
			body: JSON.stringify({ name: 'CLI', scopes: ['links:read'], expiresInDays: 30 })
		});
		expect(created.status).toBe(201);
		token = ((await created.json()) as { secret: string }).secret;
		expect((await call(`${origin}/v1/links`, { headers: { cookie: owner } })).status).toBe(401);
		const bearer = { authorization: `Bearer ${token}` };
		expect((await call(`${origin}/v1/links`, { headers: bearer })).status).toBe(200);
		expect((await call(`${origin}/api/v1/links`, { headers: bearer })).status).toBe(401);
		const mcp = await call(`${origin}/mcp`, {
			method: 'POST',
			headers: { cookie: owner, 'content-type': 'application/json', accept: 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
		});
		expect(mcp.status).toBe(401);
		const resource = await call(`${origin}/.well-known/oauth-protected-resource/mcp`);
		expect(await resource.json()).toMatchObject({
			resource: `${origin}/mcp`,
			authorization_servers: [origin]
		});
		const metadata = await call(`${origin}/.well-known/oauth-authorization-server`);
		expect(((await metadata.json()) as { issuer: string }).issuer).toBe(origin);
	});

	it('serves no auth route, cookie, or page on another host', async () => {
		calls.length = 0;
		for (const path of ['/api/auth/session', '/app', '/setup', '/first-link']) {
			const response = await call(`https://other.example${path}`, {
				headers: { cookie: owner }
			});
			expect(response.status, path).toBe(404);
			expect(response.headers.getSetCookie(), path).toEqual([]);
		}
		expect(calls).toHaveLength(0);
	});

	it('changes limits with a fresh session and the exact Origin', async () => {
		const read = await call(`${origin}/api/settings/limits`, { headers: { cookie: owner } });
		expect(await read.json()).toMatchObject({
			limits: {
				activeLinkLimit: 10000,
				monthlyClickLimit: 50000,
				retentionDays: 30,
				domainLimit: 5
			},
			pending: false
		});
		const limits = {
			activeLinkLimit: 500,
			monthlyClickLimit: 9000,
			retentionDays: 60,
			domainLimit: 2
		};
		const change = (headers: Record<string, string>, body: unknown = limits) =>
			call(`${origin}/api/settings/limits`, {
				method: 'POST',
				headers: { cookie: owner, 'content-type': 'application/json', ...headers },
				body: JSON.stringify(body)
			});
		expect(await code(await change({ origin: 'https://evil.example' }))).toBe('ORIGIN_REJECTED');
		expect(await code(await change({ origin }, { ...limits, retentionDays: 0 }))).toBe(
			'VALIDATION_FAILED'
		);
		const saved = await change({ origin });
		expect(await saved.json()).toMatchObject({ limits, pending: false });
		expect(
			await count("SELECT COUNT(*) AS n FROM owner_audit WHERE action = 'limits_changed'")
		).toBe(1);
	});
});

describe('moving the app host', () => {
	const moved = { APP_ORIGIN: movedOrigin };

	it('serves only sign-in until the owner signs in at the new address', async () => {
		const settings = await call(`${movedOrigin}/app/settings`, {}, moved);
		expect(settings.status).toBe(503);
		expect(await settings.text()).toContain(movedOrigin);
		expect(await (await call(`${movedOrigin}/app/login`, {}, moved)).text()).toBe('sveltekit');
		// The old host is a link host now; its links work and its app paths go to the new host.
		const link = await call(`${origin}/first-link`, {}, moved);
		expect(link.status).toBe(302);
		const reserved = await call(`${origin}/app`, {}, moved);
		expect(reserved.headers.get('location')).toBe(`${movedOrigin}/app`);
		// A redeploy back to the old address before any sign-in loses nothing.
		const session = await call(`${origin}/api/auth/session`, { headers: { cookie: owner } });
		expect(session.status).toBe(200);
	});

	it('ends old-origin credentials at the first password sign-in and keeps API tokens', async () => {
		await env.IDENTITY.prepare(
			"INSERT INTO passkey (id, publicKey, userId, credentialID, counter, deviceType, backedUp) SELECT 'old-passkey', 'key', id, 'credential', 0, 'singleDevice', 0 FROM \"user\""
		).run();
		const signedIn = await call(
			`${movedOrigin}/api/auth/sign-in/password`,
			{
				method: 'POST',
				headers: {
					origin: movedOrigin,
					'content-type': 'application/json',
					'cf-connecting-ip': '198.51.100.9'
				},
				body: JSON.stringify({ username: 'owner', password })
			},
			moved
		);
		expect(signedIn.status).toBe(200);
		const fresh = cookieOf(signedIn);
		expect(await count('SELECT COUNT(*) AS n FROM session')).toBe(1);
		expect(await count('SELECT COUNT(*) AS n FROM passkey')).toBe(0);
		expect(await count('SELECT COUNT(*) AS n FROM apikey')).toBe(1);
		expect(await count("SELECT COUNT(*) AS n FROM owner_audit WHERE action = 'origin_moved'")).toBe(
			1
		);
		const app = await call(`${movedOrigin}/app/settings`, { headers: { cookie: fresh } }, moved);
		expect(await app.text()).toBe('sveltekit');
		const domain = await env.ROUTING.prepare(
			"SELECT d.state FROM domains d JOIN domain_namespaces n ON n.id = d.id WHERE n.hostname = 'links.example.com'"
		).first<{ state: string }>();
		expect(domain?.state).toBe('active');
		owner = fresh;
	});
});

describe('jobs, the click Queue, and deletion', () => {
	const moved = { APP_ORIGIN: movedOrigin };

	it('runs the frequent jobs and reports health', async () => {
		const controller = createScheduledController({
			cron: '*/10 * * * *',
			scheduledTime: Date.now()
		});
		await worker.scheduled(controller, baseEnv(moved));
		expect(await count("SELECT COUNT(*) AS n FROM job_runs WHERE last_outcome = 'succeeded'")).toBe(
			4
		);
		const daily = createScheduledController({ cron: '17 3 * * *', scheduledTime: Date.now() });
		await worker.scheduled(daily, baseEnv(moved));
		expect(await count("SELECT COUNT(*) AS n FROM job_runs WHERE last_outcome = 'succeeded'")).toBe(
			10
		);
		expect((await call(`${movedOrigin}/healthz`, {}, moved)).status).toBe(200);
	});

	it('counts a click from the Queue and drops another tenant', async () => {
		const [click] = sent;
		const batch = createMessageBatch('flared-clicks', [
			{ id: 'one', timestamp: new Date(), attempts: 1, body: click },
			{
				id: 'two',
				timestamp: new Date(),
				attempts: 1,
				body: { ...click, eventId: crypto.randomUUID(), tenantId: 'other' }
			}
		]);
		const ctx = createExecutionContext();
		await worker.queue(batch, baseEnv(moved));
		const result = await getQueueResult(batch, ctx);
		expect(result.explicitAcks).toEqual(['one', 'two']);
		const total = await env.ANALYTICS_1.prepare('SELECT SUM(clicks) AS n FROM daily_totals').first<{
			n: number;
		}>();
		expect(total?.n).toBe(1);
	});

	it('closes the installation for good after the owner deletes it', async () => {
		const removed = await call(
			`${movedOrigin}/api/account/delete`,
			{
				method: 'POST',
				headers: { cookie: owner, origin: movedOrigin, 'content-type': 'application/json' },
				body: JSON.stringify({ confirmation: 'OWNER' })
			},
			moved
		);
		expect(removed.status).toBe(202);
		// Links stop at once; the job finishes after the redirect caches expire.
		await runDeletions({
			identity: env.IDENTITY,
			routing: env.ROUTING,
			shards: { 'analytics-1': env.ANALYTICS_1 },
			domains: { reservedHostnames: [] },
			now: () => Date.now() + routeSettleMs + 1000
		});
		calls.length = 0;
		await call(`${movedOrigin}/app`, {}, moved);
		expect(calls.at(-1)?.env.INSTALLATION).toEqual({ state: 'closed', moving: false });
		expect(await code(await call(`${movedOrigin}/api/v1/links`, {}, moved))).toBe(
			'INSTALLATION_CLOSED'
		);
		expect(
			(
				await call(
					`${movedOrigin}/v1/links`,
					{ headers: { authorization: `Bearer ${token}` } },
					moved
				)
			).status
		).toBe(410);
		const setup = await call(
			`${movedOrigin}/api/setup`,
			{
				method: 'POST',
				headers: {
					origin: movedOrigin,
					'content-type': 'application/json',
					'cf-connecting-ip': '198.51.100.20'
				},
				body: JSON.stringify({
					secret: setupSecret,
					username: 'owner',
					password,
					workspaceName: 'Links'
				})
			},
			moved
		);
		expect(await code(setup)).toBe('SETUP_CLOSED');
		expect((await call(`${origin}/first-link`, {}, moved)).status).toBe(404);
	});
});
