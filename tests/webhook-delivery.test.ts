// SPDX-License-Identifier: AGPL-3.0-only
// Webhook routes and delivery against real D1 and an injected receiver: who may manage
// endpoints, signatures and rotation, send outcomes, the background delivery after a change,
// test sends, and the D1 statements of each path.
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { isTokenScope, scopePresets } from '../packages/contracts/src/tokens';
import type {
	CreatedWebhookEndpoint,
	WebhookDelivery,
	WebhookEndpoint,
	WebhookEndpointPage
} from '../packages/contracts/src/webhooks';
import { createTenant } from '../packages/data/src/tenancy';
import {
	claimWebhookDeliveries,
	fanOutWebhookEvents,
	listWebhookEvents
} from '../packages/data/src/webhooks';
import {
	createApi,
	type ApiDependencies,
	type ApiPrincipal,
	type WebhookSettings
} from '../packages/server/src/api';
import { createLink } from '../packages/server/src/links';
import { suspendTenant } from '../packages/server/src/operator';
import { projectPolicy, updatePolicy } from '../packages/server/src/tenancy';
import {
	cleanupWebhooks,
	deliverWebhooks,
	runWebhookJob
} from '../packages/server/src/webhooks/deliver';
import { counting } from './support/d1-count';

const origin = 'https://app.example';
const identity = () => env.WEBHOOK_DELIVERY_IDENTITY;
const routing = () => env.WEBHOOK_DELIVERY_ROUTING;
const shard = () => env.WEBHOOK_DELIVERY_ANALYTICS;
const stores = () => ({ routing: routing(), analytics: { 'analytics-1': shard() } });
const start = Date.UTC(2026, 9, 17, 9, 12, 30, 123);
let clock = start;
const minute = 60000;
const hookUrl = 'https://hooks.example.com/in';
const rootSecret = 'test-only-webhook-root-secret';

const baseLimits = { activeLinkLimit: 100, monthlyClickLimit: 5000, retentionDays: 30 };
const tenantOf: Record<string, string> = {};

interface Received {
	url: string;
	headers: Headers;
	body: string;
}
let received: Received[] = [];
let answer: (request: Received, init: RequestInit) => Response | Promise<Response> = () =>
	new Response(null, { status: 204 });
const background: Promise<unknown>[] = [];

const receiver: typeof fetch = async (input, init = {}) => {
	const request: Received = {
		url: input instanceof Request ? input.url : String(input),
		headers: new Headers(init.headers),
		body: typeof init.body === 'string' ? init.body : ''
	};
	received.push(request);
	return answer(request, init);
};

afterEach(() => {
	received = [];
	answer = () => new Response(null, { status: 204 });
	background.length = 0;
	clock = start;
	vi.restoreAllMocks();
});

async function addUser(userId: string): Promise<void> {
	await identity()
		.prepare(
			'INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 0, 0)'
		)
		.bind(userId, '', `${userId}@example.com`)
		.run();
}

async function addTenant(userId: string, tenantId: string, webhookEndpointLimit = 5) {
	tenantOf[userId] = tenantId;
	await addUser(userId);
	await createTenant(identity(), {
		id: tenantId,
		name: 'Workspace',
		ownerUserId: userId,
		analyticsShardId: 'analytics-1',
		limits: { ...baseLimits, domainLimit: 1, webhookEndpointLimit },
		now: 1
	});
	await projectPolicy(identity(), stores(), tenantId, 1);
}

async function addMember(userId: string, tenantId: string): Promise<void> {
	tenantOf[userId] = tenantId;
	await addUser(userId);
	await identity()
		.prepare(
			"INSERT INTO tenant_memberships (tenant_id, user_id, role, created_at) VALUES (?, ?, 'member', 2)"
		)
		.bind(tenantId, userId)
		.run();
}

// x-test-scopes makes the principal an API token, x-test-oauth a connected app; without them, a
// dashboard session signed in now, or at x-test-signed-in.
function api(
	options: {
		webhooks?: Partial<WebhookSettings> | null;
		identity?: D1Database;
		routing?: D1Database;
	} = {}
) {
	const webhooks =
		options.webhooks === null
			? undefined
			: {
					secret: rootSecret,
					fetch: receiver,
					background: (task: Promise<unknown>) => void background.push(task),
					...options.webhooks
				};
	const dependencies: ApiDependencies = {
		identity: options.identity ?? identity(),
		routing: options.routing ?? routing(),
		appOrigin: origin,
		domains: { reservedHostnames: ['short.example'] },
		now: () => clock,
		authenticate: async (request): Promise<ApiPrincipal | null> => {
			const userId = request.headers.get('x-test-user');
			if (!userId) return null;
			const scopes = request.headers.get('x-test-scopes');
			if (scopes !== null)
				return {
					kind: 'token',
					userId,
					tenantId: tenantOf[userId],
					scopes: scopes.split(',').filter(isTokenScope),
					token: { id: 'token-1', name: 'Test', start: 'flr_', expiresAt: null }
				};
			if (request.headers.has('x-test-oauth'))
				return {
					kind: 'oauth',
					channel: 'mcp' as const,
					userId,
					tenantId: tenantOf[userId],
					scopes: scopePresets.full,
					clientId: 'client-1'
				};
			return {
				kind: 'session',
				userId,
				sessionId: `session-${userId}`,
				signedInAt: request.headers.get('x-test-signed-in') ?? new Date(clock).toISOString()
			};
		},
		webhooks
	};
	return createApi(dependencies);
}

async function call(
	userId: string,
	method: string,
	path: string,
	body?: unknown,
	app = api(),
	extra: Record<string, string> = {}
): Promise<{ status: number; text: string; json: unknown; headers: Headers }> {
	const headers: Record<string, string> = { 'x-test-user': userId, origin, ...extra };
	const init: RequestInit = { method, headers };
	if (body !== undefined) {
		init.body = JSON.stringify(body);
		headers['content-type'] = 'application/json';
	}
	const response = await app.fetch(new Request(`${origin}/v1${path}`, init));
	const text = await response.text();
	return {
		status: response.status,
		text,
		json: text ? JSON.parse(text) : null,
		headers: response.headers
	};
}

function codeOf(result: { json: unknown }): unknown {
	const body = result.json as { error?: { code?: unknown } } | null;
	return body?.error?.code;
}

async function addEndpoint(
	userId: string,
	input: Record<string, unknown> = {},
	app = api()
): Promise<CreatedWebhookEndpoint> {
	const created = await call(
		userId,
		'POST',
		'/webhooks',
		{ url: hookUrl, events: ['link.created', 'link.updated', 'link.disabled'], ...input },
		app
	);
	expect(created.status, created.text).toBe(201);
	return created.json as CreatedWebhookEndpoint;
}

let keyCounter = 0;
async function postLink(userId: string, input: Record<string, unknown> = {}, app = api()) {
	keyCounter += 1;
	const result = await call(
		userId,
		'POST',
		'/links',
		{ destination: 'https://example.com/a', ...input },
		app,
		{ 'idempotency-key': `key-${keyCounter}` }
	);
	expect(result.status, result.text).toBe(201);
	return result;
}

async function runBackground(): Promise<void> {
	await Promise.all(background.splice(0));
}

async function deliveries(userId: string, endpointId: string, app = api()) {
	const result = await call(userId, 'GET', `/webhooks/${endpointId}/deliveries`, undefined, app);
	expect(result.status).toBe(200);
	return (result.json as { deliveries: WebhookDelivery[] }).deliveries;
}

function base64Bytes(value: string): Uint8Array<ArrayBuffer> {
	return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

// A receiver's check, written from the Standard Webhooks rules and not from the signer.
async function verifies(secret: string, request: Received, entry: string): Promise<boolean> {
	if (!secret.startsWith('whsec_') || !entry.startsWith('v1,')) return false;
	const key = await crypto.subtle.importKey(
		'raw',
		base64Bytes(secret.slice('whsec_'.length)),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['verify']
	);
	const id = request.headers.get('webhook-id');
	const timestamp = request.headers.get('webhook-timestamp');
	return crypto.subtle.verify(
		'HMAC',
		key,
		base64Bytes(entry.slice(3)),
		new TextEncoder().encode(`${id}.${timestamp}.${request.body}`)
	);
}

function signatures(request: Received): string[] {
	return (request.headers.get('webhook-signature') ?? '').split(' ');
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
});

describe('webhook routes', () => {
	it('answer 404 when the installation has no webhook settings', async () => {
		await addTenant('u-none', 't-none');
		const result = await call('u-none', 'GET', '/webhooks', undefined, api({ webhooks: null }));
		expect([result.status, codeOf(result)]).toEqual([404, 'NOT_FOUND']);
	});

	it('are for the owner in a fresh dashboard session, and show the secret only once', async () => {
		await addTenant('u-own', 't-own');
		await addMember('u-mem', 't-own');
		const routes: [string, string, unknown?][] = [
			['GET', '/webhooks'],
			['POST', '/webhooks', { url: hookUrl, events: ['link.created'] }],
			['PATCH', '/webhooks/whk-any', { enabled: false }],
			['DELETE', '/webhooks/whk-any'],
			['POST', '/webhooks/whk-any/secret'],
			['POST', '/webhooks/whk-any/test'],
			['GET', '/webhooks/whk-any/deliveries']
		];
		for (const [method, path, body] of routes) {
			const member = await call('u-mem', method, path, body);
			expect([member.status, codeOf(member)], `${method} ${path}`).toEqual([403, 'OWNER_REQUIRED']);
			const credentials: Record<string, string>[] = [
				{ 'x-test-scopes': scopePresets.full.join(',') },
				{ 'x-test-oauth': '1' }
			];
			for (const extra of credentials) {
				const credential = await call('u-own', method, path, body, api(), extra);
				expect([credential.status, codeOf(credential)], `${method} ${path}`).toEqual([
					403,
					'INSUFFICIENT_SCOPE'
				]);
			}
		}
		const stale = { 'x-test-signed-in': new Date(clock - 3600000).toISOString() };
		const refused = await call(
			'u-own',
			'POST',
			'/webhooks',
			{ url: hookUrl, events: ['link.created'] },
			api(),
			stale
		);
		expect([refused.status, codeOf(refused)]).toEqual([403, 'REAUTH_REQUIRED']);

		const created = await addEndpoint('u-own');
		expect(created.secret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
		expect(created.endpoint).toMatchObject({
			url: hookUrl,
			events: ['link.created', 'link.updated', 'link.disabled'],
			milestoneInterval: null,
			enabled: true,
			secretChanged: false,
			previousSecretUntil: null
		});
		const rotateStale = await call(
			'u-own',
			'POST',
			`/webhooks/${created.endpoint.id}/secret`,
			undefined,
			api(),
			stale
		);
		expect([rotateStale.status, codeOf(rotateStale)]).toEqual([403, 'REAUTH_REQUIRED']);

		const listed = await call('u-own', 'GET', '/webhooks');
		expect(listed.status).toBe(200);
		expect(listed.text).not.toContain('whsec_');
		expect(listed.text).not.toContain('"secret"');
		const page = listed.json as WebhookEndpointPage;
		expect(page).toMatchObject({ used: 1, limit: 5, endpoints: [created.endpoint] });
		expect(page.eventTypes).toContain('link.click_milestone');
		for (const path of ['', '/deliveries'])
			expect(
				(await call('u-own', 'GET', `/webhooks/${created.endpoint.id}${path}`)).text
			).not.toContain('whsec_');
		const updated = await call('u-own', 'PATCH', `/webhooks/${created.endpoint.id}`, {
			events: ['link.click_milestone']
		});
		expect(updated.status).toBe(200);
		expect(updated.text).not.toContain('whsec_');
		expect((updated.json as { endpoint: WebhookEndpoint }).endpoint).toMatchObject({
			events: ['link.click_milestone'],
			milestoneInterval: 1000
		});
		const wrongMethod = await call('u-own', 'PUT', `/webhooks/${created.endpoint.id}`);
		expect([wrongMethod.status, wrongMethod.headers.get('allow')]).toEqual([405, 'PATCH, DELETE']);
	});

	it('never reach another workspace’s endpoint', async () => {
		await addTenant('u-ta', 't-ta');
		await addTenant('u-tb', 't-tb');
		await addEndpoint('u-ta');
		const other = await addEndpoint('u-tb');
		const id = other.endpoint.id;
		for (const [method, path, body] of [
			['PATCH', `/webhooks/${id}`, { enabled: false }],
			['DELETE', `/webhooks/${id}`],
			['POST', `/webhooks/${id}/secret`],
			['POST', `/webhooks/${id}/test`],
			['GET', `/webhooks/${id}/deliveries`]
		] as const) {
			const result = await call('u-ta', method, path, body);
			expect([result.status, codeOf(result)], `${method} ${path}`).toEqual([404, 'NOT_FOUND']);
		}
		expect(received).toEqual([]);
		const page = (await call('u-tb', 'GET', '/webhooks')).json as WebhookEndpointPage;
		expect(page.endpoints).toEqual([other.endpoint]);
	});

	it('keep the endpoint limit and still list endpoints at limit 0', async () => {
		await addTenant('u-lim', 't-lim', 2);
		const first = await addEndpoint('u-lim');
		await addEndpoint('u-lim');
		const third = await call('u-lim', 'POST', '/webhooks', {
			url: hookUrl,
			events: ['link.created']
		});
		expect([third.status, codeOf(third)]).toEqual([403, 'WEBHOOK_LIMIT_REACHED']);
		await updatePolicy(
			identity(),
			stores(),
			't-lim',
			{ ...baseLimits, domainLimit: 1, webhookEndpointLimit: 0 },
			2
		);
		const refused = await call('u-lim', 'POST', '/webhooks', {
			url: hookUrl,
			events: ['link.created']
		});
		expect([refused.status, codeOf(refused)]).toEqual([403, 'WEBHOOK_LIMIT_REACHED']);
		const page = (await call('u-lim', 'GET', '/webhooks')).json as WebhookEndpointPage;
		expect([page.used, page.limit, page.endpoints.length]).toEqual([2, 0, 2]);
		const test = await call('u-lim', 'POST', `/webhooks/${first.endpoint.id}/test`);
		expect([test.status, codeOf(test)]).toEqual([403, 'WEBHOOK_LIMIT_REACHED']);
		await postLink('u-lim');
		expect(background).toHaveLength(0);
	});

	it('let a suspended workspace delete endpoints and nothing else', async () => {
		await addTenant('u-sus', 't-sus');
		const created = await addEndpoint('u-sus');
		await suspendTenant(identity(), stores(), { kind: 'operator', id: 'admin-1' } as const, {
			tenantId: 't-sus',
			reason: 'spam',
			now: clock
		});
		const add = await call('u-sus', 'POST', '/webhooks', {
			url: hookUrl,
			events: ['link.created']
		});
		expect(codeOf(add)).toBe('WORKSPACE_SUSPENDED');
		const test = await call('u-sus', 'POST', `/webhooks/${created.endpoint.id}/test`);
		expect(codeOf(test)).toBe('WORKSPACE_SUSPENDED');
		expect((await call('u-sus', 'GET', '/webhooks')).status).toBe(200);
		expect((await call('u-sus', 'DELETE', `/webhooks/${created.endpoint.id}`)).status).toBe(204);
		const page = (await call('u-sus', 'GET', '/webhooks')).json as WebhookEndpointPage;
		expect(page.endpoints).toEqual([]);
	});
});

describe('delivery after a change', () => {
	it('sends a signed event after a create and an edit, within the statement budget', async () => {
		await addTenant('u-send', 't-send');
		const { endpoint, secret } = await addEndpoint('u-send');
		const counter = { queries: 0 };
		const countedApp = api({
			identity: counting(identity(), counter),
			routing: counting(routing(), counter)
		});

		counter.queries = 0;
		const created = await postLink('u-send', { title: 'First' }, countedApp);
		expect(background).toHaveLength(1);
		// The delivery starts before the response is complete, so both are counted together.
		await runBackground();
		const createQueries = counter.queries;
		expect(received).toHaveLength(1);
		const [delivery] = received;
		const { link } = created.json as { link: { id: string } };
		expect(delivery.url).toBe(hookUrl);
		expect(delivery.headers.get('content-type')).toBe('application/json');
		expect(delivery.headers.get('user-agent')).toBe('Flared-Webhooks/1.0');
		expect(delivery.headers.get('webhook-timestamp')).toBe(String(Math.floor(clock / 1000)));
		const body = JSON.parse(delivery.body);
		expect(body).toEqual({
			id: delivery.headers.get('webhook-id'),
			type: 'link.created',
			timestamp: new Date(clock).toISOString(),
			workspace: { id: 't-send' },
			data: created.json
		});
		expect(body.id).toMatch(/^evt_[0-9a-f]{32}$/);
		expect(signatures(delivery)).toHaveLength(1);
		expect(await verifies(secret, delivery, signatures(delivery)[0])).toBe(true);
		const tampered = { ...delivery, body: delivery.body.replace('First', 'Fir5t') };
		expect(await verifies(secret, tampered, signatures(delivery)[0])).toBe(false);
		expect(await deliveries('u-send', endpoint.id)).toMatchObject([
			{ eventType: 'link.created', state: 'succeeded', attempts: 1, responseStatus: 204 }
		]);

		// A replay of the create stages nothing.
		const replay = await call(
			'u-send',
			'POST',
			'/links',
			{ destination: 'https://example.com/a', title: 'First' },
			api(),
			{ 'idempotency-key': `key-${keyCounter}` }
		);
		expect(replay.headers.get('idempotent-replayed')).toBe('true');
		expect(background).toHaveLength(0);

		clock += 1000;
		counter.queries = 0;
		const edited = await call(
			'u-send',
			'PATCH',
			`/links/${link.id}`,
			{ enabled: false },
			countedApp
		);
		expect(edited.status).toBe(200);
		await runBackground();
		const patchQueries = counter.queries;
		expect(received).toHaveLength(2);
		const disabled = JSON.parse(received[1].body);
		expect(disabled).toMatchObject({
			type: 'link.disabled',
			data: { link: { id: link.id, enabled: false }, previous: { enabled: true, title: 'First' } }
		});
		expect(received[1].headers.get('webhook-id')).not.toBe(delivery.headers.get('webhook-id'));

		// An edit that changes nothing staged no event, so nothing runs after it.
		const same = await call('u-send', 'PATCH', `/links/${link.id}`, { title: 'First' });
		expect(same.status).toBe(200);
		expect(background).toHaveLength(0);

		// Measured with the delivery after each (the fan-out batch of 3, the claim, the read, and
		// the result batch of 2): a create 13 + 7, an edit 6 + 7.
		expect([createQueries, patchQueries]).toEqual([20, 13]);
	});

	it('records each send outcome, never follows a redirect, and retries with the same ID', async () => {
		await addTenant('u-out', 't-out');
		const { endpoint, secret } = await addEndpoint('u-out');
		const send = () =>
			deliverWebhooks(routing(), 't-out', {
				secret: rootSecret,
				reservedHostnames: [],
				fetch: receiver,
				now: () => clock
			});
		const state = async () =>
			routing()
				.prepare(
					'SELECT d.state, d.attempts, d.next_attempt_at, d.error_code, d.response_status, w.paused_until FROM webhook_deliveries d JOIN webhook_endpoints w ON w.id = d.endpoint_id WHERE d.tenant_id = ? ORDER BY d.created_at DESC, d.rowid DESC LIMIT 1'
				)
				.bind('t-out')
				.first();

		// 500: tried again after a minute, and the endpoint waits as long.
		answer = () => new Response('busy', { status: 500 });
		await postLink('u-out', {}, api({ webhooks: { background: undefined } }));
		await send();
		expect(await state()).toEqual({
			state: 'pending',
			attempts: 1,
			next_attempt_at: clock + minute,
			error_code: 'http_status',
			response_status: 500,
			paused_until: clock + minute
		});
		const firstId = received[0].headers.get('webhook-id');
		// Another change waits for the pause.
		await postLink('u-out', {}, api({ webhooks: { background: undefined } }));
		await send();
		expect(received).toHaveLength(1);

		// After the pause: a 2xx succeeds, with the same webhook-id and a new timestamp.
		clock += minute;
		answer = () => new Response('ok');
		const run = await runWebhookJob(stores(), {
			secret: rootSecret,
			reservedHostnames: [],
			fetch: receiver,
			now: () => clock
		});
		expect(run).toMatchObject({ sent: 2, succeeded: 2, failed: 0 });
		const retried = received.find(
			(request, index) => index > 0 && request.headers.get('webhook-id') === firstId
		);
		expect(retried?.headers.get('webhook-timestamp')).toBe(String(Math.floor(clock / 1000)));
		expect(retried && (await verifies(secret, retried, signatures(retried)[0]))).toBe(true);
		const history = await deliveries('u-out', endpoint.id);
		expect(
			history.map((item) => [item.state, item.attempts]).sort((a, b) => Number(a[1]) - Number(b[1]))
		).toEqual([
			['succeeded', 1],
			['succeeded', 2]
		]);

		// 302: a failure; the Location is never fetched.
		received = [];
		answer = () =>
			new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/x' } });
		await postLink('u-out', {}, api({ webhooks: { background: undefined } }));
		await send();
		expect(received.map((request) => request.url)).toEqual([hookUrl]);
		expect(await state()).toMatchObject({ error_code: 'redirect', response_status: 302 });

		// A run that claimed and stopped: the delivery goes out after the backoff, same ID.
		clock += 10 * minute;
		received = [];
		await routing()
			.prepare("UPDATE webhook_endpoints SET paused_until = NULL WHERE tenant_id = 't-out'")
			.run();
		answer = () => new Response(null, { status: 204 });
		// Earlier deliveries are done, so only the new one is due.
		await routing()
			.prepare(
				"UPDATE webhook_deliveries SET state = 'succeeded' WHERE tenant_id = 't-out' AND state = 'pending'"
			)
			.run();
		await postLink('u-out', {}, api({ webhooks: { background: undefined } }));
		await fanOutWebhookEvents(routing(), { now: clock, limit: 10, tenantId: 't-out' });
		expect(
			await claimWebhookDeliveries(routing(), { now: clock, limit: 10, tenantId: 't-out' })
		).toHaveLength(1);
		expect(received).toEqual([]);
		const [event] = await listWebhookEvents(routing(), 't-out', 1);
		clock += minute;
		received = [];
		await runWebhookJob(stores(), {
			secret: rootSecret,
			reservedHostnames: [],
			fetch: receiver,
			now: () => clock
		});
		expect(received.map((request) => request.headers.get('webhook-id'))).toContain(event.id);

		// A network error is a failure; the tenth failed attempt ends the delivery.
		received = [];
		answer = () => {
			throw new TypeError('connection refused');
		};
		await routing()
			.prepare("UPDATE webhook_endpoints SET paused_until = NULL WHERE tenant_id = 't-out'")
			.run();
		await postLink('u-out', {}, api({ webhooks: { background: undefined } }));
		await send();
		expect(await state()).toMatchObject({ state: 'pending', error_code: 'network' });
		await routing()
			.prepare(
				"UPDATE webhook_deliveries SET attempts = 9, next_attempt_at = ? WHERE tenant_id = 't-out' AND state = 'pending'"
			)
			.bind(clock)
			.run();
		await routing()
			.prepare("UPDATE webhook_endpoints SET paused_until = NULL WHERE tenant_id = 't-out'")
			.run();
		await runWebhookJob(stores(), {
			secret: rootSecret,
			reservedHostnames: [],
			fetch: receiver,
			now: () => clock
		});
		expect(await state()).toMatchObject({ state: 'failed', attempts: 10, error_code: 'network' });
	});

	it('times out a receiver that does not answer within 10 seconds', async () => {
		await addTenant('u-slow', 't-slow');
		const { endpoint } = await addEndpoint('u-slow');
		let signal: AbortSignal | null | undefined;
		answer = (_request, init) =>
			new Promise((_resolve, reject) => {
				signal = init.signal;
				init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
			});
		await postLink('u-slow');
		const started = Date.now();
		await runBackground();
		expect(signal).toBeInstanceOf(AbortSignal);
		expect(Date.now() - started).toBeGreaterThanOrEqual(9900);
		const [delivery] = await deliveries('u-slow', endpoint.id);
		expect(delivery).toMatchObject({
			state: 'pending',
			errorCode: 'timeout',
			responseStatus: null
		});
		expect(delivery.durationMs).toBeGreaterThanOrEqual(9900);
	}, 30000);

	it('reads at most 1 KB of a response and logs no URL, destination, payload, or secret', async () => {
		await addTenant('u-log', 't-log');
		const url = 'https://hooks.private-receiver.com/in?token=abc123';
		const { secret } = await addEndpoint('u-log', { url });
		const lines: string[] = [];
		for (const method of ['log', 'error', 'warn', 'info'] as const)
			vi.spyOn(console, method).mockImplementation((...values: unknown[]) => {
				lines.push(values.map(String).join(' '));
			});
		let pulled = 0;
		let cancelled = false;
		answer = () =>
			new Response(
				new ReadableStream<Uint8Array>({
					pull(controller) {
						pulled += 512;
						controller.enqueue(new Uint8Array(512));
						if (pulled >= 100 * 512) controller.close();
					},
					cancel() {
						cancelled = true;
					}
				}),
				{ status: 500 }
			);
		await postLink('u-log', { destination: 'https://secret-destination.example/path' });
		await runBackground();
		expect(received).toHaveLength(1);
		expect(cancelled).toBe(true);
		expect(pulled).toBeLessThanOrEqual(2048);
		const logged = lines.join('\n');
		expect(logged).toContain('webhook_retry');
		for (const hidden of [
			'private-receiver',
			'token=abc123',
			'secret-destination',
			'whsec_',
			secret
		])
			expect(logged).not.toContain(hidden);
	});
});

describe('secrets', () => {
	it('signs with the old and the new secret for 24 hours after a rotation', async () => {
		await addTenant('u-rot', 't-rot');
		const created = await addEndpoint('u-rot');
		const id = created.endpoint.id;
		const rotated = await call('u-rot', 'POST', `/webhooks/${id}/secret`);
		expect(rotated.status).toBe(200);
		const next = rotated.json as CreatedWebhookEndpoint;
		expect(next.secret).not.toBe(created.secret);
		expect(next.endpoint).toMatchObject({
			previousSecretUntil: new Date(clock + 86400000).toISOString(),
			secretChanged: false
		});
		expect((await call('u-rot', 'POST', `/webhooks/${id}/test`)).status).toBe(200);
		const [old, current] = signatures(received[0]);
		expect(await verifies(created.secret, received[0], old)).toBe(true);
		expect(await verifies(next.secret, received[0], current)).toBe(true);
		expect(await verifies(created.secret, received[0], current)).toBe(false);

		clock += 86400000 + 1;
		expect((await call('u-rot', 'POST', `/webhooks/${id}/test`)).status).toBe(200);
		expect(signatures(received[1])).toHaveLength(1);
		expect(await verifies(next.secret, received[1], signatures(received[1])[0])).toBe(true);
	});

	it('fails deliveries signed under a changed deployment secret until a rotation', async () => {
		await addTenant('u-key', 't-key');
		const created = await addEndpoint('u-key');
		const moved = api({ webhooks: { secret: 'test-only-another-root-secret' } });
		const listed = (await call('u-key', 'GET', '/webhooks', undefined, moved))
			.json as WebhookEndpointPage;
		expect(listed.endpoints[0].secretChanged).toBe(true);
		const test = await call(
			'u-key',
			'POST',
			`/webhooks/${created.endpoint.id}/test`,
			undefined,
			moved
		);
		expect(test.status).toBe(200);
		expect((test.json as { delivery: WebhookDelivery }).delivery).toMatchObject({
			state: 'failed',
			errorCode: 'secret_changed',
			responseStatus: null
		});
		expect(received).toEqual([]);
		// Not the receiver's fault: the endpoint is not paused.
		expect(listed.endpoints[0].pausedUntil).toBeNull();

		const rotated = await call(
			'u-key',
			'POST',
			`/webhooks/${created.endpoint.id}/secret`,
			undefined,
			moved
		);
		const next = rotated.json as CreatedWebhookEndpoint;
		// The old secret cannot be derived any more, so it signs nothing.
		expect(next.endpoint).toMatchObject({ secretChanged: false, previousSecretUntil: null });
		const again = await call(
			'u-key',
			'POST',
			`/webhooks/${created.endpoint.id}/test`,
			undefined,
			moved
		);
		expect((again.json as { delivery: WebhookDelivery }).delivery.state).toBe('succeeded');
		expect(signatures(received[0])).toHaveLength(1);
		expect(await verifies(next.secret, received[0], signatures(received[0])[0])).toBe(true);
		const page = (await call('u-key', 'GET', '/webhooks', undefined, moved))
			.json as WebhookEndpointPage;
		expect(page.endpoints[0].secretChanged).toBe(false);
	});
});

describe('test sends', () => {
	it('deliver at once, also to an endpoint that is off, within the hourly limit', async () => {
		await addTenant('u-test', 't-test');
		const { endpoint, secret } = await addEndpoint('u-test');
		const app = api({ webhooks: { testsPerHour: 2 } });
		const off = await call('u-test', 'PATCH', `/webhooks/${endpoint.id}`, { enabled: false }, app);
		expect((off.json as { endpoint: WebhookEndpoint }).endpoint.enabled).toBe(false);
		const sent = await call('u-test', 'POST', `/webhooks/${endpoint.id}/test`, undefined, app);
		expect(sent.status).toBe(200);
		const delivery = (sent.json as { delivery: WebhookDelivery }).delivery;
		expect(delivery).toMatchObject({
			eventType: 'webhook.test',
			state: 'succeeded',
			attempts: 1,
			responseStatus: 204
		});
		expect(JSON.parse(received[0].body)).toMatchObject({
			id: delivery.eventId,
			type: 'webhook.test',
			workspace: { id: 't-test' },
			data: { message: 'Test event from Flared.' }
		});
		expect(await verifies(secret, received[0], signatures(received[0])[0])).toBe(true);
		// A link change does not reach an endpoint that is off.
		await postLink('u-test', {}, app);
		await runBackground();
		expect(received).toHaveLength(1);

		expect(
			(await call('u-test', 'POST', `/webhooks/${endpoint.id}/test`, undefined, app)).status
		).toBe(200);
		const refused = await call('u-test', 'POST', `/webhooks/${endpoint.id}/test`, undefined, app);
		expect([refused.status, codeOf(refused)]).toEqual([429, 'RATE_LIMITED']);
		expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
		expect(received).toHaveLength(2);
		const history = await deliveries('u-test', endpoint.id, app);
		expect(history.map((item) => item.eventType)).toEqual(['webhook.test', 'webhook.test']);
		expect(history[0].createdAt >= history[1].createdAt).toBe(true);
	});
});

describe('scheduled job', () => {
	it('moves milestones, sends at most 25 deliveries 5 at a time, and stays within budget', async () => {
		await addTenant('u-job', 't-job');
		await addEndpoint('u-job', {
			events: ['link.created', 'link.click_milestone'],
			milestoneInterval: 100
		});
		let linkId = '';
		for (let index = 0; index < 30; index += 1) {
			const result = await createLink(routing(), {
				tenantId: 't-job',
				key: `job-${index}`,
				input: {
					destination: `https://example.com/job/${index}`,
					slug: null,
					title: null,
					domainId: null,
					iosDestination: null,
					androidDestination: null
				},
				requestId: 'request-1',
				now: clock
			});
			linkId = (JSON.parse(result.body) as { link: { id: string } }).link.id;
		}
		await shard()
			.prepare(
				'INSERT INTO click_milestones (id, tenant_id, link_id, clicks, created_at) VALUES (?, ?, ?, 100, ?)'
			)
			.bind(`link.click_milestone:${linkId}:100`, 't-job', linkId, clock)
			.run();
		let open = 0;
		let most = 0;
		answer = async () => {
			open += 1;
			most = Math.max(most, open);
			await new Promise((resolve) => setTimeout(resolve, 5));
			open -= 1;
			return new Response(null, { status: 204 });
		};
		const counter = { queries: 0 };
		const run = await runWebhookJob(
			{
				routing: counting(routing(), counter),
				analytics: { 'analytics-1': counting(shard(), counter) }
			},
			{ secret: rootSecret, reservedHostnames: [], fetch: receiver, now: () => clock }
		);
		expect(run).toMatchObject({ milestones: 1, events: 31, sent: 25, succeeded: 25 });
		expect(received).toHaveLength(25);
		expect(most).toBe(5);
		// Transfer 4 (read, the batch of events and automation marks, delete), fan-out 3, claim 1,
		// read 1, results 2.
		expect(counter.queries).toBe(11);
		expect(await shard().prepare('SELECT COUNT(*) AS n FROM click_milestones').first('n')).toBe(0);
		const rest = await runWebhookJob(stores(), {
			secret: rootSecret,
			reservedHostnames: [],
			fetch: receiver,
			now: () => clock
		});
		expect(rest.sent).toBe(6);
		expect(
			received.filter((request) => JSON.parse(request.body).type === 'link.click_milestone')
		).toHaveLength(1);

		counter.queries = 0;
		await cleanupWebhooks(counting(routing(), counter), clock);
		expect(counter.queries).toBe(3);
	});

	it('leaves click milestones on the shards when the automation job moves them', async () => {
		await addTenant('u-keep', 't-keep');
		const linkId = (JSON.parse((await postLink('u-keep')).text) as { link: { id: string } }).link
			.id;
		await runBackground();
		received = [];
		await shard()
			.prepare(
				"INSERT INTO click_milestones (id, tenant_id, link_id, clicks, created_at) VALUES (?, 't-keep', ?, 100, ?)"
			)
			.bind(`link.click_milestone:${linkId}:100`, linkId, clock)
			.run();
		const counter = { queries: 0 };
		const run = await runWebhookJob(
			{ routing: routing(), analytics: { 'analytics-1': counting(shard(), counter) } },
			{
				secret: rootSecret,
				reservedHostnames: [],
				fetch: receiver,
				now: () => clock,
				transferMilestones: false
			}
		);
		expect(run.milestones).toBe(0);
		expect(counter.queries).toBe(0);
		expect(
			await shard()
				.prepare("SELECT COUNT(*) AS n FROM click_milestones WHERE tenant_id = 't-keep'")
				.first('n')
		).toBe(1);
		await shard().prepare("DELETE FROM click_milestones WHERE tenant_id = 't-keep'").run();
	});

	it('sends an automation event only while its endpoint is on; a test reaches it off', async () => {
		await addTenant('u-target', 't-target');
		const { endpoint } = await addEndpoint('u-target');
		const stage = (id: string) =>
			routing()
				.prepare(
					"INSERT INTO webhook_events (id, tenant_id, type, subject_id, target_endpoint_id, payload, created_at) VALUES (?, 't-target', 'automation.triggered', NULL, ?, '{}', ?)"
				)
				.bind(id, endpoint.id, clock)
				.run();
		// Fanned out while the endpoint is on, then turned off before the send.
		await stage('evt_target_1');
		await fanOutWebhookEvents(routing(), { now: clock, limit: 100, tenantId: 't-target' });
		const off = await call('u-target', 'PATCH', `/webhooks/${endpoint.id}`, { enabled: false });
		expect(off.status).toBe(200);
		// Staged while it is off: no delivery at all.
		await stage('evt_target_2');
		await runWebhookJob(stores(), {
			secret: rootSecret,
			reservedHostnames: [],
			fetch: receiver,
			now: () => clock,
			transferMilestones: false
		});
		expect(received).toEqual([]);
		expect(await deliveries('u-target', endpoint.id)).toMatchObject([
			{
				eventId: 'evt_target_1',
				eventType: 'automation.triggered',
				state: 'skipped',
				errorCode: 'disabled'
			}
		]);
		const test = await call('u-target', 'POST', `/webhooks/${endpoint.id}/test`);
		expect(test.status).toBe(200);
		expect(received.map((request) => JSON.parse(request.body).type)).toEqual(['webhook.test']);
	});

	it('refuses a URL that a later check no longer accepts, without a request', async () => {
		await addTenant('u-url', 't-url');
		const { endpoint } = await addEndpoint('u-url');
		await routing()
			.prepare('UPDATE webhook_endpoints SET url = ? WHERE id = ?')
			.bind('https://short.example/in', endpoint.id)
			.run();
		await postLink('u-url');
		await runBackground();
		expect(received).toEqual([]);
		expect(await deliveries('u-url', endpoint.id)).toMatchObject([
			{ state: 'failed', errorCode: 'invalid_url' }
		]);
	});
});
