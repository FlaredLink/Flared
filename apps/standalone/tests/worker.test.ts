// SPDX-License-Identifier: AGPL-3.0-only
// The standalone Worker entry against real D1: the configuration gate, the setup gate, host
// routing, credential separation between the session API, the token API, and MCP, the limits
// and update routes, an app host move, the scheduled jobs, the click Queue, and the closed
// installation.
import { env } from 'cloudflare:workers';
import {
	applyD1Migrations,
	createExecutionContext,
	createMessageBatch,
	createScheduledController,
	getQueueResult,
	waitOnExecutionContext
} from 'cloudflare:test';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ClickEvent } from '@flared/contracts/analytics';
import { routeSettleMs, runDeletions } from '@flared/server/deletion';
import worker, { type StandaloneEnv } from '../worker/index';
import { counting } from '../../../tests/support/d1-count';
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
	it('names an invalid secret and suggests the address only', async () => {
		for (const value of ['https://flared.example.workers.dev/app', 'http://x.example', 'pending']) {
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

	it('adds an own domain as a Worker Custom Domain and serves its challenge only there', async () => {
		const added = await call(`${origin}/api/v1/domains`, {
			method: 'POST',
			headers: browser(owner),
			body: JSON.stringify({ hostname: 'go.own.example.com' })
		});
		expect(added.status).toBe(201);
		const { domain } = (await added.json()) as {
			domain: { id: string; setup: string; records: unknown[] };
		};
		expect(domain).toMatchObject({ setup: 'worker_custom_domain', records: [] });
		const path = '/.well-known/flared-domain-challenge';
		const own = await call(`https://go.own.example.com${path}`);
		expect(own.status).toBe(200);
		expect(await own.text()).toMatch(/^[0-9a-f]{64}$/);
		expect((await call(`${origin}${path}`)).status).toBe(404);
		expect((await call(`https://go.other.example.com${path}`)).status).toBe(404);
		// Removed, so the frequent job below has no hostname to fetch over the network.
		const removed = await call(`${origin}/api/v1/domains/${domain.id}`, {
			method: 'DELETE',
			headers: browser(owner)
		});
		expect(removed.status).toBe(204);
		expect((await call(`https://go.own.example.com${path}`)).status).toBe(404);
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
				domainLimit: 5,
				memberLimit: 10,
				webhookEndpointLimit: 10,
				automationLimit: 25
			},
			pending: false
		});
		const limits = {
			activeLinkLimit: 500,
			monthlyClickLimit: 9000,
			retentionDays: 60,
			domainLimit: 2,
			memberLimit: 3
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
		for (const webhookEndpointLimit of [51, -1, 2.5, '10'])
			expect(
				await code(await change({ origin }, { ...limits, webhookEndpointLimit })),
				String(webhookEndpointLimit)
			).toBe('VALIDATION_FAILED');
		// A page loaded before the webhook endpoint limit existed sends the other five; the stored
		// value stays.
		const saved = await change({ origin });
		expect(await saved.json()).toMatchObject({
			limits: { ...limits, webhookEndpointLimit: 10 },
			pending: false
		});
		for (const webhookEndpointLimit of [0, 50]) {
			const bounded = await change({ origin }, { ...limits, webhookEndpointLimit });
			expect(await bounded.json()).toMatchObject({
				limits: { ...limits, webhookEndpointLimit },
				pending: false
			});
		}
		expect(
			await count("SELECT COUNT(*) AS n FROM owner_audit WHERE action = 'limits_changed'")
		).toBe(3);
	});

	it('takes an automation limit from 0 to 100 and keeps it when a page leaves it out', async () => {
		const limits = {
			activeLinkLimit: 500,
			monthlyClickLimit: 9000,
			retentionDays: 60,
			domainLimit: 2,
			memberLimit: 3,
			webhookEndpointLimit: 50
		};
		const change = (body: unknown) =>
			call(`${origin}/api/settings/limits`, {
				method: 'POST',
				headers: { cookie: owner, origin, 'content-type': 'application/json' },
				body: JSON.stringify(body)
			});
		for (const automationLimit of [101, -1, 2.5, '25'])
			expect(
				await code(await change({ ...limits, automationLimit })),
				String(automationLimit)
			).toBe('VALIDATION_FAILED');
		for (const automationLimit of [0, 100])
			expect(await (await change({ ...limits, automationLimit })).json()).toMatchObject({
				limits: { ...limits, automationLimit },
				pending: false
			});
		expect(await (await change(limits)).json()).toMatchObject({
			limits: { ...limits, automationLimit: 100 },
			pending: false
		});
		expect(await (await change({ ...limits, automationLimit: 25 })).json()).toMatchObject({
			limits: { automationLimit: 25 },
			bounds: { automationLimit: { min: 0, max: 100 } }
		});
	});

	it('adds a member by invite link, who reads but cannot change the limits', async () => {
		const workspace = (await (
			await call(`${origin}/api/v1/workspace`, { headers: { cookie: owner } })
		).json()) as { workspace: { id: string } };
		const shown = { 'x-flared-workspace': workspace.workspace.id };
		const created = await call(`${origin}/api/v1/invites`, {
			method: 'POST',
			headers: browser(owner),
			body: '{}'
		});
		expect(created.status).toBe(201);
		const { url } = (await created.json()) as { url: string };
		const accepted = await call(`${origin}/api/auth/invite/accept`, {
			method: 'POST',
			headers: browser(''),
			body: JSON.stringify({
				token: url.slice(url.indexOf('#') + 1),
				username: 'Member.One',
				password: 'member password one'
			})
		});
		expect(accepted.status).toBe(200);
		const member = cookieOf(accepted);
		expect(
			(await call(`${origin}/api/settings/limits`, { headers: { cookie: member } })).status
		).toBe(200);
		const refused = await call(`${origin}/api/settings/limits`, {
			method: 'POST',
			headers: browser(member),
			body: JSON.stringify({
				activeLinkLimit: 1,
				monthlyClickLimit: 1,
				retentionDays: 1,
				domainLimit: 0,
				memberLimit: 1
			})
		});
		expect([refused.status, await code(refused)]).toEqual([403, 'OWNER_REQUIRED']);
		const updates = await call(`${origin}/api/settings/updates`, {
			method: 'POST',
			headers: browser(member),
			body: JSON.stringify({ enabled: true })
		});
		expect([updates.status, await code(updates)]).toEqual([403, 'OWNER_REQUIRED']);
		// The workspace header reaches the API, so the member can leave the shown workspace.
		const left = await call(`${origin}/api/v1/workspace/leave`, {
			method: 'POST',
			headers: browser(member, shown)
		});
		expect(left.status).toBe(204);
	});
});

describe('webhooks', () => {
	it('delivers at most 25 in a frequent run within the Free plan budget', async () => {
		const created = await call(`${origin}/api/v1/webhooks`, {
			method: 'POST',
			headers: browser(owner),
			body: JSON.stringify({ url: 'https://hooks.example.net/flared', events: ['link.created'] })
		});
		expect(created.status).toBe(201);
		const { endpoint } = (await created.json()) as { endpoint: { id: string } };
		const tenant = await env.IDENTITY.prepare(
			'SELECT fixed_tenant_id AS id FROM installation WHERE id = 1'
		).first<{ id: string }>();
		const tenantId = tenant?.id ?? '';
		const staged = Date.now();
		await env.ROUTING.batch(
			Array.from({ length: 30 }, (_, index) =>
				env.ROUTING.prepare(
					"INSERT INTO webhook_events (id, tenant_id, type, payload, created_at) VALUES (?, ?, 'link.created', ?, ?)"
				).bind(`evt_budget_${index}`, tenantId, JSON.stringify({ index }), staged)
			)
		);
		// The first run of an hour also samples the database size.
		const hour = Math.ceil((staged + 1) / 3_600_000) * 3_600_000;
		const counter = { queries: 0 };
		const sentUrls: string[] = [];
		const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
			sentUrls.push(input instanceof Request ? input.url : String(input));
			return new Response('ok');
		});
		try {
			await worker.scheduled(
				createScheduledController({ cron: '*/10 * * * *', scheduledTime: hour }),
				baseEnv({
					IDENTITY: counting(env.IDENTITY, counter),
					ROUTING: counting(env.ROUTING, counter),
					ANALYTICS_1: counting(env.ANALYTICS_1, counter)
				})
			);
		} finally {
			spy.mockRestore();
		}
		expect(sentUrls).toHaveLength(25);
		expect(new Set(sentUrls)).toEqual(new Set(['https://hooks.example.net/flared']));
		expect(counter.queries).toBeLessThan(50);
		const states = await env.ROUTING.prepare(
			'SELECT state, COUNT(*) AS n FROM webhook_deliveries WHERE endpoint_id = ? GROUP BY state ORDER BY state'
		)
			.bind(endpoint.id)
			.all<{ state: string; n: number }>();
		expect(states.results).toEqual([
			{ state: 'pending', n: 5 },
			{ state: 'succeeded', n: 25 }
		]);
		// Deleting the endpoint removes its deliveries, so no later job sends them over the network.
		const removed = await call(`${origin}/api/v1/webhooks/${endpoint.id}`, {
			method: 'DELETE',
			headers: browser(owner)
		});
		expect(removed.status).toBe(204);
	});
});

// The 10-minute runs take turns: domain checks when the scheduled minute / 10 is even, automations
// when it is odd. Each turn's worst case stays inside the 50 subrequests and 50 D1 queries of one
// Workers Free invocation.
describe('the frequent run budget', () => {
	const challengePath = '/.well-known/flared-domain-challenge';
	const hostnames = [1, 2, 3, 4, 5].map((n) => `go${n}.budget.example.com`);
	// A fresh hour after the one the webhook test sampled: on the hour, k = 0.
	const hour = Math.ceil((Date.now() + 1) / 3_600_000) * 3_600_000 + 3_600_000;
	let tenantId = '';
	let endpointId = '';
	const domainIds: string[] = [];
	const linkIds: string[] = [];

	async function stageWork(round: string): Promise<void> {
		// A policy revision that the stores have not acknowledged.
		await env.IDENTITY.prepare(
			'UPDATE tenant_policy SET revision = revision + 1, updated_at = ? WHERE tenant_id = ?'
		)
			.bind(Date.now(), tenantId)
			.run();
		const staged = Date.now();
		await env.ROUTING.batch(
			Array.from({ length: 30 }, (_, index) =>
				env.ROUTING.prepare(
					"INSERT INTO webhook_events (id, tenant_id, type, payload, created_at) VALUES (?, ?, 'link.created', ?, ?)"
				).bind(`evt_${round}_${index}`, tenantId, JSON.stringify({ index }), staged)
			)
		);
		// 50 milestones: one transfer batch.
		await env.ANALYTICS_1.batch(
			linkIds.flatMap((id) =>
				[100, 200].map((clicks) =>
					env.ANALYTICS_1.prepare(
						'INSERT INTO click_milestones (id, tenant_id, link_id, clicks, created_at) VALUES (?, ?, ?, ?, ?)'
					).bind(`link.click_milestone:${id}:${round}${clicks}`, tenantId, id, clicks, staged)
				)
			)
		);
	}

	async function scheduledRun(
		scheduledTime: number
	): Promise<{ queries: number; fetched: string[] }> {
		const counter = { queries: 0 };
		const fetched: string[] = [];
		const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
			fetched.push(input instanceof Request ? input.url : String(input));
			return new Response('ok');
		});
		try {
			await worker.scheduled(
				createScheduledController({ cron: '*/10 * * * *', scheduledTime }),
				baseEnv({
					IDENTITY: counting(env.IDENTITY, counter),
					ROUTING: counting(env.ROUTING, counter),
					ANALYTICS_1: counting(env.ANALYTICS_1, counter)
				})
			);
		} finally {
			spy.mockRestore();
		}
		return { queries: counter.queries, fetched };
	}

	async function applicationStates(): Promise<Record<string, number>> {
		const { results } = await env.ROUTING.prepare(
			'SELECT state, COUNT(*) AS n FROM link_automations WHERE tenant_id = ? GROUP BY state'
		)
			.bind(tenantId)
			.all<{ state: string; n: number }>();
		return Object.fromEntries(results.map((row) => [row.state, row.n]));
	}

	async function jobOutcome(job: string, after: number): Promise<string | null> {
		const row = await env.IDENTITY.prepare(
			'SELECT last_outcome FROM job_runs WHERE job = ? AND last_finished_at >= ?'
		)
			.bind(job, after)
			.first<{ last_outcome: string }>();
		return row?.last_outcome ?? null;
	}

	it('stages 5 waiting domains, a webhook endpoint, and 25 due automation applications', async () => {
		const tenant = await env.IDENTITY.prepare(
			'SELECT fixed_tenant_id AS id FROM installation WHERE id = 1'
		).first<{ id: string }>();
		tenantId = tenant?.id ?? '';
		const raised = await call(`${origin}/api/settings/limits`, {
			method: 'POST',
			headers: browser(owner),
			body: JSON.stringify({
				activeLinkLimit: 500,
				monthlyClickLimit: 9000,
				retentionDays: 60,
				domainLimit: 10,
				memberLimit: 3
			})
		});
		expect(raised.status).toBe(200);
		for (const hostname of hostnames) {
			const added = await call(`${origin}/api/v1/domains`, {
				method: 'POST',
				headers: browser(owner),
				body: JSON.stringify({ hostname })
			});
			expect(added.status, hostname).toBe(201);
			domainIds.push(((await added.json()) as { domain: { id: string } }).domain.id);
		}
		for (let index = 0; index < 25; index += 1) {
			const link = await call(`${origin}/api/v1/links`, {
				method: 'POST',
				headers: browser(owner, { 'idempotency-key': crypto.randomUUID() }),
				body: JSON.stringify({
					destination: `https://example.com/sale/${index}`,
					slug: `budget-${index}`
				})
			});
			expect(link.status).toBe(201);
			linkIds.push(((await link.json()) as { link: { id: string } }).link.id);
		}
		// After the links, so their link.created events reach no endpoint.
		const created = await call(`${origin}/api/v1/webhooks`, {
			method: 'POST',
			headers: browser(owner),
			body: JSON.stringify({
				url: 'https://hooks.example.net/budget',
				events: ['link.created', 'link.updated', 'link.disabled', 'link.click_milestone'],
				milestoneInterval: 100
			})
		});
		expect(created.status).toBe(201);
		endpointId = ((await created.json()) as { endpoint: { id: string } }).endpoint.id;
		// Every action this edition offers.
		const template = await call(`${origin}/api/v1/automations`, {
			method: 'POST',
			headers: browser(owner),
			body: JSON.stringify({
				name: 'Sale ends',
				trigger: { type: 'end_date' },
				actions: [
					{ type: 'change_destination', destination: 'https://example.com/sale-over' },
					{ type: 'disable_link' },
					{ type: 'send_webhook', endpointId }
				]
			})
		});
		expect(template.status).toBe(201);
		const { automation } = (await template.json()) as { automation: { id: string } };
		// An end date in the past: due at the next automation turn.
		const applied = await call(`${origin}/api/v1/automations/${automation.id}/links`, {
			method: 'POST',
			headers: browser(owner),
			body: JSON.stringify({ linkIds, endsAt: new Date(Date.now() - 60_000).toISOString() })
		});
		expect(applied.status).toBe(200);
		const { results } = (await applied.json()) as { results: { status: string }[] };
		expect(results.filter((result) => result.status === 'applied')).toHaveLength(25);
		// The email action is not offered without email.
		const email = await call(`${origin}/api/v1/automations`, {
			method: 'POST',
			headers: browser(owner),
			body: JSON.stringify({
				name: 'Email',
				trigger: { type: 'end_date' },
				actions: [{ type: 'email_owner' }]
			})
		});
		expect(await code(email)).toBe('INVALID_INPUT');
	});

	it('checks domains and leaves automations in an even turn, within the budget', async () => {
		await stageWork('even');
		const before = Date.now();
		const { queries, fetched } = await scheduledRun(hour);
		console.log(JSON.stringify({ turn: 'even', queries, fetches: fetched.length }));
		expect(queries).toBeLessThan(50);
		expect(fetched.length).toBeLessThanOrEqual(45);
		// 3 of the 5 waiting domains, least recently fetched first.
		expect(fetched.filter((url) => url.endsWith(challengePath))).toHaveLength(3);
		expect(fetched.filter((url) => url === 'https://hooks.example.net/budget')).toHaveLength(25);
		expect(await applicationStates()).toEqual({ waiting: 25 });
		// The webhook job moved the milestones in this turn.
		expect(
			(
				await env.ANALYTICS_1.prepare('SELECT COUNT(*) AS n FROM click_milestones').first<{
					n: number;
				}>()
			)?.n
		).toBe(0);
		for (const job of ['policy_projections', 'domain_checks', 'automations', 'webhook_deliveries'])
			expect(await jobOutcome(job, before), job).toBe('succeeded');
	});

	it('runs automations and leaves domains in an odd turn, within the budget', async () => {
		await stageWork('odd');
		const before = Date.now();
		const { queries, fetched } = await scheduledRun(hour + 10 * 60_000);
		console.log(JSON.stringify({ turn: 'odd', queries, fetches: fetched.length }));
		expect(queries).toBeLessThan(50);
		expect(fetched.length).toBeLessThanOrEqual(45);
		expect(fetched.filter((url) => url.endsWith(challengePath))).toEqual([]);
		expect(fetched.filter((url) => url === 'https://hooks.example.net/budget')).toHaveLength(25);
		expect(await applicationStates()).toEqual({ done: 25 });
		const changed = await env.ROUTING.prepare(
			"SELECT COUNT(*) AS n FROM links WHERE tenant_id = ? AND status = 'disabled' AND destination = 'https://example.com/sale-over'"
		)
			.bind(tenantId)
			.first<{ n: number }>();
		expect(changed?.n).toBe(25);
		// The automation job moved the milestones, and its webhook events wait for delivery.
		expect(
			(
				await env.ANALYTICS_1.prepare('SELECT COUNT(*) AS n FROM click_milestones').first<{
					n: number;
				}>()
			)?.n
		).toBe(0);
		const triggered = await env.ROUTING.prepare(
			"SELECT COUNT(*) AS n FROM webhook_events WHERE tenant_id = ? AND type = 'automation.triggered' AND target_endpoint_id = ?"
		)
			.bind(tenantId, endpointId)
			.first<{ n: number }>();
		expect(triggered?.n).toBe(25);
		for (const job of ['policy_projections', 'domain_checks', 'automations', 'webhook_deliveries'])
			expect(await jobOutcome(job, before), job).toBe('succeeded');
	});

	it('removes the staged domains and endpoint, so no later job fetches them', async () => {
		for (const id of domainIds)
			expect(
				(
					await call(`${origin}/api/v1/domains/${id}`, {
						method: 'DELETE',
						headers: browser(owner)
					})
				).status
			).toBe(204);
		expect(
			(
				await call(`${origin}/api/v1/webhooks/${endpointId}`, {
					method: 'DELETE',
					headers: browser(owner)
				})
			).status
		).toBe(204);
	});
});

describe('update checks', () => {
	const change = (headers: Record<string, string>, body: unknown) =>
		call(`${origin}/api/settings/updates`, {
			method: 'POST',
			headers: { cookie: owner, 'content-type': 'application/json', ...headers },
			body: JSON.stringify(body)
		});

	it('lets the owner turn them on, which checks at once, and off, which clears the result', async () => {
		const release = {
			version: '0.2.0',
			publishedAt: '2026-11-02T09:00:00.000Z',
			notesUrl: 'https://github.com/FlaredLink/Flared/releases/tag/v0.2.0',
			summary: 'Update notices.',
			migrations: false,
			breaking: false
		};
		const feed = vi
			.spyOn(globalThis, 'fetch')
			.mockImplementation(async () => Response.json(release));
		try {
			expect(await code(await change({ origin: 'https://evil.example' }, { enabled: true }))).toBe(
				'ORIGIN_REJECTED'
			);
			expect(await code(await change({ origin }, { enabled: 'yes' }))).toBe('VALIDATION_FAILED');
			expect(feed).not.toHaveBeenCalled();
			const on = await change({ origin }, { enabled: true });
			expect(await on.json()).toMatchObject({
				ok: true,
				updates: { enabled: true, latest: release }
			});
			expect(feed).toHaveBeenCalledTimes(1);
			const [request] = feed.mock.calls[0];
			expect(
				request instanceof Request ? request.headers.get('cookie') : 'not a request'
			).toBeNull();
			const off = await change({ origin }, { enabled: false });
			expect(await off.json()).toMatchObject({
				ok: true,
				updates: { enabled: false, latest: null }
			});
			expect(feed).toHaveBeenCalledTimes(1);
		} finally {
			feed.mockRestore();
		}
		expect(
			(await call(`${origin}/api/settings/updates`, { headers: { cookie: owner } })).status
		).toBe(405);
	});

	it('gives pages the stored check', async () => {
		calls.length = 0;
		await call(`${origin}/app/settings`, { headers: { cookie: owner } });
		const updates = calls.at(-1)?.env.UPDATES as { read(): Promise<unknown> } | undefined;
		expect(await updates?.read()).toEqual({
			enabled: false,
			checkedAt: null,
			failedAt: null,
			latest: null
		});
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
			"INSERT INTO passkey (id, publicKey, userId, credentialID, counter, deviceType, backedUp) SELECT 'old-passkey', 'key', id, 'credential', 0, 'singleDevice', 0 FROM \"user\" WHERE username = 'owner'"
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
			7
		);
		const daily = createScheduledController({ cron: '17 3 * * *', scheduledTime: Date.now() });
		await worker.scheduled(daily, baseEnv(moved));
		expect(await count("SELECT COUNT(*) AS n FROM job_runs WHERE last_outcome = 'succeeded'")).toBe(
			16
		);
		const recorded = await env.IDENTITY.prepare(
			"SELECT job FROM job_runs WHERE job IN ('webhook_deliveries', 'webhook_cleanup') ORDER BY job"
		).all<{ job: string }>();
		expect(recorded.results.map((row) => row.job)).toEqual([
			'webhook_cleanup',
			'webhook_deliveries'
		]);
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
