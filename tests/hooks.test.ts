// SPDX-License-Identifier: AGPL-3.0-only
// REST hooks against real D1: routing migration 0012, subscribing with the plan, the cap, and the
// replacement of a maker's hook with the same event and URL, deleting by maker and credential,
// fan-out with expiry and tenancy, delivery through the hook sender, cleanup of ended hooks, and
// the /v1/hooks routes with revocation, suspension, and roles.
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import type { SubscribableWebhookEvent } from '../packages/contracts/src/webhooks';
import { createTenant } from '../packages/data/src/tenancy';
import {
	deleteEndedHooks,
	deleteHooks,
	fanOutWebhookEvents,
	hookTransport,
	maxHooksPerWorkspace,
	subscribeHook,
	type HookMaker,
	type WebhookEndpointRow
} from '../packages/data/src/webhooks';
import type { CreatedHook } from '../packages/contracts/src/webhooks';
import { createApi, type ApiPrincipal } from '../packages/server/src/api';
import { createLink } from '../packages/server/src/links';
import { projectPolicy } from '../packages/server/src/tenancy';
import { cleanupWebhooks, runWebhookJob } from '../packages/server/src/webhooks/deliver';
import { hookSender } from '../packages/server/src/webhooks/hooks';

const identity = () => env.HOOKS_IDENTITY;
const routing = () => env.HOOKS_ROUTING;
const shard = () => env.HOOKS_ANALYTICS;
const stores = () => ({ routing: routing(), analytics: { 'analytics-1': shard() } });
const start = Date.UTC(2026, 9, 20, 9, 0, 0, 0);
const day = 86400000;
const zapUrl = 'https://hooks.zapier.com/hooks/standard/1/a/';
const baseLimits = {
	activeLinkLimit: 200,
	monthlyClickLimit: 5000,
	retentionDays: 30,
	domainLimit: 1,
	webhookEndpointLimit: 5,
	automationLimit: 25
};

async function addTenant(
	userId: string,
	tenantId: string,
	limits: Partial<typeof baseLimits> = {}
): Promise<void> {
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
		limits: { ...baseLimits, ...limits },
		now: 1
	});
	await projectPolicy(identity(), stores(), tenantId, 1);
}

// The target key that subscribeHook stores.
async function keyOf(userId: string, event: string, url: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(JSON.stringify([userId, event, url]))
	);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

let hookCounter = 0;
async function subscribe(
	tenantId: string,
	options: {
		event?: SubscribableWebhookEvent;
		url?: string;
		maker?: HookMaker;
		now?: number;
		lifetime?: number;
	} = {}
) {
	hookCounter += 1;
	const now = options.now ?? start;
	return subscribeHook(routing(), {
		id: `hok_${hookCounter}`,
		tenantId,
		event: options.event ?? 'link.created',
		targetUrl: options.url ?? `${zapUrl}${hookCounter}`,
		milestoneInterval: null,
		maker: options.maker ?? { userId: 'owner', credential: 'token:tok-1' },
		now,
		expiresAt: now + (options.lifetime ?? 14 * day)
	});
}

async function created(
	tenantId: string,
	options: Parameters<typeof subscribe>[1] = {}
): Promise<WebhookEndpointRow> {
	const result = await subscribe(tenantId, options);
	if (result.status !== 'created') throw new Error(`Expected a created hook: ${result.status}`);
	return result.endpoint;
}

async function hookIds(tenantId: string): Promise<string[]> {
	const { results } = await routing()
		.prepare(
			'SELECT id FROM webhook_endpoints WHERE tenant_id = ? AND transport = ? ORDER BY created_at, id'
		)
		.bind(tenantId, hookTransport)
		.all<{ id: string }>();
	return results.map((row) => row.id);
}

let eventCounter = 0;
async function stageEvent(
	tenantId: string,
	type: string,
	at: number,
	payload: unknown = { link: { id: 'lnk_1' } }
): Promise<string> {
	eventCounter += 1;
	const id = `evt_${eventCounter}`;
	await routing()
		.prepare(
			'INSERT INTO webhook_events (id, tenant_id, type, subject_id, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)'
		)
		.bind(id, tenantId, type, 'lnk_1', JSON.stringify(payload), at)
		.run();
	return id;
}

async function deliveredTo(eventId: string): Promise<string[]> {
	const { results } = await routing()
		.prepare('SELECT endpoint_id FROM webhook_deliveries WHERE event_id = ? ORDER BY endpoint_id')
		.bind(eventId)
		.all<{ endpoint_id: string }>();
	return results.map((row) => row.endpoint_id);
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

describe('routing migration 0012', () => {
	it('adds expires_at to existing endpoints as NULL and indexes it', async () => {
		const db = env.HOOKS_MIGRATION;
		const migrations = env.ROUTING_MIGRATIONS;
		const index = migrations.findIndex((item) => item.name.startsWith('0012_'));
		expect(index).toBeGreaterThan(0);
		await applyD1Migrations(db, migrations.slice(0, index), 'flared_core_migrations');
		await db
			.prepare(
				"INSERT INTO webhook_endpoints (id, tenant_id, url, events, key_id, created_at, updated_at) VALUES ('wh-1', 't-old', 'https://hooks.example.com/in', '[\"link.created\"]', 'key-1', 10, 10)"
			)
			.run();
		await applyD1Migrations(db, migrations, 'flared_core_migrations');
		const row = await db
			.prepare("SELECT expires_at, url, transport FROM webhook_endpoints WHERE id = 'wh-1'")
			.first();
		expect(row).toEqual({
			expires_at: null,
			url: 'https://hooks.example.com/in',
			transport: 'http'
		});
		const indexRow = await db
			.prepare("SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = ?")
			.bind('webhook_endpoints_expiry')
			.first();
		expect(indexRow).toEqual({ tbl_name: 'webhook_endpoints' });
	});
});

describe('subscribeHook', () => {
	beforeAll(async () => {
		await addTenant('owner', 'ws-plus');
		await addTenant('free-owner', 'ws-free', { webhookEndpointLimit: 0 });
		await addTenant('cap-owner', 'ws-cap');
		await addTenant('race-owner', 'ws-race');
	});

	it('stores a hook of the resthook transport with its maker and expiry', async () => {
		const hook = await created('ws-plus', {
			event: 'link.click_milestone',
			maker: { userId: 'owner', credential: 'oauth:client-z' }
		});
		expect(hook).toMatchObject({
			tenantId: 'ws-plus',
			transport: hookTransport,
			events: ['link.click_milestone'],
			milestoneInterval: 1000,
			enabled: true,
			keyId: 'transport',
			expiresAt: start + 14 * day,
			createdAt: start
		});
		expect(hook.targetKey).toMatch(/^[0-9a-f]{64}$/);
		expect(JSON.parse(hook.target ?? 'null')).toEqual({
			userId: 'owner',
			credential: 'oauth:client-z'
		});
	});

	it('refuses a workspace with webhooks off and an unknown workspace', async () => {
		expect(await subscribe('ws-free')).toEqual({ status: 'limit', limit: 0 });
		// A hook from before a downgrade stays when a subscribe is refused.
		await routing()
			.prepare(
				"INSERT INTO webhook_endpoints (id, tenant_id, transport, target_key, url, events, key_id, expires_at, created_at, updated_at) VALUES ('hok_old', 'ws-free', 'resthook', ?, ?, '[\"link.created\"]', 'transport', ?, 1, 1)"
			)
			.bind(await keyOf('owner', 'link.created', `${zapUrl}old`), `${zapUrl}old`, start + day)
			.run();
		expect(await subscribe('ws-free', { url: `${zapUrl}old` })).toEqual({
			status: 'limit',
			limit: 0
		});
		expect(await hookIds('ws-free')).toEqual(['hok_old']);
		await routing().prepare("DELETE FROM webhook_endpoints WHERE id = 'hok_old'").run();
		expect(await subscribe('ws-missing')).toEqual({ status: 'no_workspace' });
		expect(await hookIds('ws-free')).toEqual([]);
	});

	it('caps live hooks at 50 and does not count expired ones', async () => {
		await created('ws-cap', { now: start - 20 * day });
		for (let index = 0; index < maxHooksPerWorkspace; index += 1) await created('ws-cap');
		expect(await subscribe('ws-cap')).toEqual({ status: 'limit', limit: maxHooksPerWorkspace });
		expect(await hookIds('ws-cap')).toHaveLength(maxHooksPerWorkspace + 1);
	});

	it('lets no two subscribes at once pass the cap', async () => {
		for (let index = 0; index < maxHooksPerWorkspace - 2; index += 1) await created('ws-race');
		const results = await Promise.all(Array.from({ length: 6 }, () => subscribe('ws-race')));
		expect(results.filter((result) => result.status === 'created')).toHaveLength(2);
		expect(await hookIds('ws-race')).toHaveLength(maxHooksPerWorkspace);
	});

	it('replaces the hook with the same event and URL', async () => {
		const url = `${zapUrl}same`;
		const first = await created('ws-plus', { url });
		const other = await created('ws-plus', { url, event: 'link.updated' });
		const second = await created('ws-plus', { url, now: start + day });
		expect(second.id).not.toBe(first.id);
		const ids = await hookIds('ws-plus');
		expect(ids).not.toContain(first.id);
		expect(ids).toContain(other.id);
		expect(ids).toContain(second.id);
		// Another member's subscribe to the same URL leaves this maker's hook alone.
		const colleague = await created('ws-plus', {
			url,
			maker: { userId: 'colleague', credential: 'token:tok-c' }
		});
		expect(await hookIds('ws-plus')).toEqual(expect.arrayContaining([second.id, colleague.id]));
	});

	it('replaces a hook at the cap', async () => {
		const url = `${zapUrl}full`;
		await addTenant('full-owner', 'ws-full');
		for (let index = 0; index < maxHooksPerWorkspace - 1; index += 1) await created('ws-full');
		const first = await created('ws-full', { url });
		const again = await subscribe('ws-full', { url });
		expect(again.status).toBe('created');
		expect(await hookIds('ws-full')).not.toContain(first.id);
		expect(await hookIds('ws-full')).toHaveLength(maxHooksPerWorkspace);
	});
});

describe('deleteHooks', () => {
	beforeAll(async () => {
		await addTenant('del-owner', 'ws-del');
	});

	it('deletes by hook, by maker, and by maker and credential, in one workspace only', async () => {
		const ava = { userId: 'ava', credential: 'token:tok-a' };
		const avaApp = { userId: 'ava', credential: 'oauth:client-z' };
		const ben = { userId: 'ben', credential: 'token:tok-b' };
		const a1 = await created('ws-del', { maker: ava });
		const a2 = await created('ws-del', { maker: avaApp });
		const a3 = await created('ws-del', { maker: avaApp });
		const b1 = await created('ws-del', { maker: ben });
		const b2 = await created('ws-del', { maker: ben });
		await addTenant('other-owner', 'ws-other');
		const elsewhere = await created('ws-other', { maker: avaApp });

		expect(await deleteHooks(routing(), 'ws-del', { hookId: b1.id, userId: 'ava' })).toBe(0);
		expect(await deleteHooks(routing(), 'ws-other', { hookId: b1.id })).toBe(0);
		expect(await deleteHooks(routing(), 'ws-del', { hookId: b1.id, userId: 'ben' })).toBe(1);
		expect(
			await deleteHooks(routing(), 'ws-del', { userId: 'ava', credential: 'oauth:client-z' })
		).toBe(2);
		expect(await hookIds('ws-del')).toEqual([a1.id, b2.id]);
		expect(await deleteHooks(routing(), 'ws-del', { userId: 'ava' })).toBe(1);
		expect(await deleteHooks(routing(), 'ws-del', { hookId: b2.id })).toBe(1);
		expect(await hookIds('ws-del')).toEqual([]);
		expect(await hookIds('ws-other')).toEqual([elsewhere.id]);
		expect([a2.id, a3.id]).not.toContain(elsewhere.id);
	});

	it('deletes the deliveries of a deleted hook', async () => {
		const hook = await created('ws-del', { maker: { userId: 'cal', credential: 'session' } });
		const eventId = await stageEvent('ws-del', 'link.created', start + 1);
		await fanOutWebhookEvents(routing(), { now: start + 2, limit: 100, tenantId: 'ws-del' });
		expect(await deliveredTo(eventId)).toEqual([hook.id]);
		expect(await deleteHooks(routing(), 'ws-del', { userId: 'cal' })).toBe(1);
		expect(await deliveredTo(eventId)).toEqual([]);
	});
});

describe('fan-out to hooks', () => {
	beforeAll(async () => {
		await addTenant('fan-a', 'ws-fan-a');
		await addTenant('fan-b', 'ws-fan-b');
	});

	it('sends a hook its own event type only, in its own workspace, until it expires', async () => {
		const created1 = await created('ws-fan-a', { event: 'link.created' });
		const updated = await created('ws-fan-a', { event: 'link.updated' });
		const short = await created('ws-fan-a', { event: 'link.created', lifetime: 10 });
		const other = await created('ws-fan-b', { event: 'link.created' });

		const createdEvent = await stageEvent('ws-fan-a', 'link.created', start + 5);
		const updatedEvent = await stageEvent('ws-fan-a', 'link.updated', start + 5);
		const lateEvent = await stageEvent('ws-fan-a', 'link.created', start + 10);
		const otherEvent = await stageEvent('ws-fan-b', 'link.created', start + 5);
		await fanOutWebhookEvents(routing(), { now: start + 20, limit: 100 });

		expect(await deliveredTo(createdEvent)).toEqual([created1.id, short.id].sort());
		expect(await deliveredTo(updatedEvent)).toEqual([updated.id]);
		expect(await deliveredTo(lateEvent)).toEqual([created1.id]);
		expect(await deliveredTo(otherEvent)).toEqual([other.id]);
		const { results } = await routing()
			.prepare('SELECT COUNT(*) AS n FROM webhook_deliveries WHERE endpoint_id = ?')
			.bind(other.id)
			.all<{ n: number }>();
		expect(results[0]?.n).toBe(1);
	});
});

describe('deleteEndedHooks', () => {
	beforeAll(async () => {
		await addTenant('end-owner', 'ws-end');
	});

	it('deletes expired hooks and hooks the receiver ended, with their deliveries', async () => {
		const live = await created('ws-end');
		const expired = await created('ws-end', { lifetime: day });
		const gone = await created('ws-end');
		const eventId = await stageEvent('ws-end', 'link.created', start + 1);
		await fanOutWebhookEvents(routing(), { now: start + 2, limit: 100, tenantId: 'ws-end' });
		expect(await deliveredTo(eventId)).toEqual([live.id, expired.id, gone.id].sort());
		await routing()
			.prepare(
				"UPDATE webhook_endpoints SET enabled = 0, off_reason = 'target_unavailable' WHERE id = ?"
			)
			.bind(gone.id)
			.run();
		const remaining = (await hookIds('ws-end')).length;
		const deleted = await deleteEndedHooks(routing(), start + day, 1000);
		expect(deleted).toBeGreaterThanOrEqual(2);
		const ids = await hookIds('ws-end');
		expect(ids).toEqual([live.id]);
		expect(remaining).toBe(3);
		expect(await deliveredTo(eventId)).toEqual([live.id]);
	});
});

describe('hook delivery', () => {
	const allowedHosts = ['hooks.zapier.com'];
	let requests: { url: string; headers: Headers; body: string }[] = [];
	let answer: () => Response | Promise<Response> = () => new Response('ok', { status: 200 });
	const receiver: typeof fetch = async (input, init = {}) => {
		requests.push({
			url: String(input),
			headers: new Headers(init.headers),
			body: typeof init.body === 'string' ? init.body : ''
		});
		return answer();
	};
	let clock = start + 2 * day;
	const job = () =>
		runWebhookJob(
			{ routing: routing(), analytics: { 'analytics-1': shard() } },
			{
				secret: 'test-only-hook-secret',
				reservedHostnames: ['short.example'],
				transports: { [hookTransport]: hookSender({ allowedHosts, fetch: receiver }) },
				transferMilestones: false,
				now: () => clock
			}
		);
	const delivery = async (eventId: string) =>
		routing()
			.prepare(
				'SELECT state, error_code, response_status, attempts FROM webhook_deliveries WHERE event_id = ?'
			)
			.bind(eventId)
			.first();
	const endpoint = async (id: string) =>
		routing()
			.prepare('SELECT enabled, off_reason FROM webhook_endpoints WHERE id = ?')
			.bind(id)
			.first();

	beforeAll(async () => {
		await addTenant('send-owner', 'ws-send');
		// Sends what the earlier tests staged, so each test sees only its own requests.
		await job();
	});

	it('posts a link change as one flat object with its event', async () => {
		requests = [];
		const hook = await created('ws-send', { now: clock });
		const result = await createLink(routing(), {
			tenantId: 'ws-send',
			key: 'hook-link-1',
			input: {
				destination: 'https://example.com/landing',
				slug: 'hooked',
				title: 'Hooked',
				domainId: null,
				iosDestination: null,
				androidDestination: null,
				startsAt: null,
				endsAt: null,
				endedDestination: null,
				password: null,
				previewTitle: null,
				previewDescription: null
			},
			requestId: 'request-1',
			now: clock
		});
		expect(result.status, result.body).toBe(201);
		const link = (JSON.parse(result.body) as { link: Record<string, unknown> }).link;
		const summary = await job();
		expect(summary.succeeded).toBe(1);
		expect(requests).toHaveLength(1);
		const [request] = requests;
		expect(request?.url).toBe(hook.url);
		const body = JSON.parse(request?.body ?? '{}') as Record<string, unknown>;
		expect(body).toEqual({
			...link,
			event: 'link.created',
			eventId: request?.headers.get('webhook-id'),
			occurredAt: new Date(clock).toISOString()
		});
		expect(body.id).toBe(link.id);
		expect(body.shortUrl).toBe(link.shortUrl);
		expect(request?.headers.get('content-type')).toBe('application/json');
		expect(request?.headers.get('user-agent')).toBe('Flared-Hooks/1.0');
		expect(request?.headers.get('webhook-signature')).toBeNull();
		await deleteHooks(routing(), 'ws-send', { hookId: hook.id });
	});

	it('keeps clicks and the previous state beside the link fields', async () => {
		requests = [];
		const milestones = await created('ws-send', { event: 'link.click_milestone', now: clock });
		const updates = await created('ws-send', { event: 'link.updated', now: clock });
		const link = {
			id: 'lnk_9',
			shortUrl: 'https://flared.link/abc',
			destination: 'https://a.example/'
		};
		const previous = { destination: 'https://b.example/', title: null, enabled: true };
		await stageEvent('ws-send', 'link.click_milestone', clock, { link, clicks: 1000 });
		await stageEvent('ws-send', 'link.updated', clock, { link, previous });
		await job();
		const bodies = requests.map((request) => JSON.parse(request.body) as Record<string, unknown>);
		expect(bodies).toContainEqual(
			expect.objectContaining({ ...link, clicks: 1000, event: 'link.click_milestone' })
		);
		expect(bodies).toContainEqual(
			expect.objectContaining({ ...link, previous, event: 'link.updated' })
		);
		await deleteHooks(routing(), 'ws-send', { hookId: milestones.id });
		await deleteHooks(routing(), 'ws-send', { hookId: updates.id });
	});

	it('turns a hook off on 410, sends it nothing more, and cleanup deletes it', async () => {
		requests = [];
		answer = () => new Response('gone', { status: 410 });
		const hook = await created('ws-send', { now: clock });
		const first = await stageEvent('ws-send', 'link.created', clock);
		await job();
		expect(await delivery(first)).toMatchObject({
			state: 'failed',
			error_code: 'target_unavailable',
			response_status: 410
		});
		expect(await endpoint(hook.id)).toEqual({ enabled: 0, off_reason: 'target_unavailable' });
		answer = () => new Response('ok', { status: 200 });
		requests = [];
		clock += 1;
		const second = await stageEvent('ws-send', 'link.created', clock);
		await job();
		expect(requests).toHaveLength(0);
		expect(await delivery(second)).toBeNull();
		const expired = await created('ws-send', { now: clock, lifetime: 10 });
		const live = await created('ws-send', { now: clock });
		const cleaned = await cleanupWebhooks(routing(), clock + 10);
		expect(cleaned.hooks).toBeGreaterThanOrEqual(2);
		expect(await endpoint(hook.id)).toBeNull();
		expect(await endpoint(expired.id)).toBeNull();
		expect(await endpoint(live.id)).toEqual({ enabled: 1, off_reason: null });
		await deleteHooks(routing(), 'ws-send', { hookId: live.id });
	});

	it('retries a redirect, a timeout, and a server error', async () => {
		const hook = await created('ws-send', { now: clock });
		for (const [make, code, status] of [
			[
				() => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }),
				'redirect',
				302
			],
			[() => Promise.reject(new DOMException('slow', 'TimeoutError')), 'timeout', null],
			[() => new Response('busy', { status: 503 }), 'http_status', 503]
		] as const) {
			answer = make;
			clock += 60 * 60000;
			const eventId = await stageEvent('ws-send', 'link.created', clock);
			await job();
			expect(await delivery(eventId)).toMatchObject({
				state: 'pending',
				error_code: code,
				response_status: status,
				attempts: 1
			});
			await routing()
				.prepare('UPDATE webhook_endpoints SET paused_until = NULL, failure_count = 0 WHERE id = ?')
				.bind(hook.id)
				.run();
		}
		answer = () => new Response('ok', { status: 200 });
		expect(await endpoint(hook.id)).toEqual({ enabled: 1, off_reason: null });
		await deleteHooks(routing(), 'ws-send', { hookId: hook.id });
	});

	it('fails a stored payload that is not an object without a request', async () => {
		requests = [];
		const hook = await created('ws-send', { now: clock });
		const eventId = await stageEvent('ws-send', 'link.created', clock, ['not', 'an', 'object']);
		await job();
		expect(requests).toHaveLength(0);
		expect(await delivery(eventId)).toMatchObject({ state: 'failed', error_code: 'rejected' });
		await deleteHooks(routing(), 'ws-send', { hookId: hook.id });
	});

	it('fails a target off the host list without a request', async () => {
		requests = [];
		const hook = await created('ws-send', { now: clock, url: 'https://hooks.example.com/in' });
		const eventId = await stageEvent('ws-send', 'link.created', clock);
		await job();
		expect(requests).toHaveLength(0);
		expect(await delivery(eventId)).toMatchObject({ state: 'failed', error_code: 'invalid_url' });
		await deleteHooks(routing(), 'ws-send', { hookId: hook.id });
	});
});

describe('hook routes', () => {
	const origin = 'https://app.example';
	const allowedHosts = ['hooks.zapier.com'];
	const target = (name: string) => `https://hooks.zapier.com/hooks/standard/9/${name}/`;
	let clock = start;
	const api = (hooks: { allowedHosts: string[] } | null = { allowedHosts }) =>
		createApi({
			identity: identity(),
			routing: routing(),
			analytics: { 'analytics-1': shard() },
			appOrigin: origin,
			now: () => clock,
			webhooks: { secret: 'test-only-hook-secret', hooks: hooks ?? undefined },
			authenticate: async (request) => {
				const raw = request.headers.get('x-test-principal');
				return raw ? (JSON.parse(raw) as ApiPrincipal) : null;
			}
		});
	const token = (
		userId: string,
		tenantId: string,
		tokenId: string,
		scopes: string[] = ['links:read']
	) => ({
		kind: 'token',
		userId,
		tenantId,
		scopes,
		token: { id: tokenId, name: 'Zap', start: 'flr_zap', expiresAt: null }
	});
	const oauth = (userId: string, tenantId: string, clientId: string) => ({
		kind: 'oauth',
		userId,
		tenantId,
		scopes: ['links:read'],
		clientId,
		channel: 'api'
	});
	const session = (userId: string) => ({
		kind: 'session',
		userId,
		sessionId: `session-${userId}`,
		signedInAt: new Date(clock).toISOString()
	});
	async function call(
		principal: unknown,
		method: string,
		path: string,
		body?: unknown,
		app = api(),
		extra: Record<string, string> = {}
	): Promise<{ status: number; json: unknown }> {
		const headers: Record<string, string> = { origin, ...extra };
		if (principal !== null) headers['x-test-principal'] = JSON.stringify(principal);
		const init: RequestInit = { method, headers };
		if (body !== undefined) {
			init.body = JSON.stringify(body);
			headers['content-type'] = 'application/json';
		}
		const response = await app.fetch(new Request(`${origin}/v1${path}`, init));
		const text = await response.text();
		return { status: response.status, json: text ? JSON.parse(text) : null };
	}
	const codeOf = (result: { json: unknown }) =>
		(result.json as { error?: { code?: unknown } } | null)?.error?.code;
	const fieldOf = (result: { json: unknown }) =>
		(result.json as { error?: { field?: unknown } } | null)?.error?.field;
	async function hookOf(principal: unknown, name: string): Promise<string> {
		const result = await call(principal, 'POST', '/hooks', {
			event: 'link.created',
			targetUrl: target(name)
		});
		expect(result.status, JSON.stringify(result.json)).toBe(201);
		return (result.json as CreatedHook).hook.id;
	}
	async function addMember(userId: string, tenantId: string): Promise<void> {
		await identity()
			.prepare(
				'INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 0, 0)'
			)
			.bind(userId, '', `${userId}@example.com`)
			.run();
		await identity()
			.prepare(
				"INSERT INTO tenant_memberships (tenant_id, user_id, role, created_at) VALUES (?, ?, 'member', 2)"
			)
			.bind(tenantId, userId)
			.run();
	}

	beforeAll(async () => {
		await addTenant('r-own', 'ws-r');
		await addMember('r-mem', 'ws-r');
		await addMember('r-mem2', 'ws-r');
		await addTenant('r-free', 'ws-r-free', { webhookEndpointLimit: 0 });
		await addTenant('r-b', 'ws-r-b');
	});

	it('subscribes for an API token and for an OAuth app, with a 7-day renewal and a 14-day end', async () => {
		for (const principal of [
			token('r-own', 'ws-r', 'tok-own'),
			oauth('r-own', 'ws-r', 'client-zap')
		]) {
			const result = await call(principal, 'POST', '/hooks', {
				event: 'link.click_milestone',
				targetUrl: target(`renew-${principal.kind}`)
			});
			expect(result.status).toBe(201);
			const { hook } = result.json as CreatedHook;
			expect(hook).toEqual({
				id: expect.stringMatching(/^hok_[0-9a-f]{32}$/),
				event: 'link.click_milestone',
				milestoneInterval: 1000,
				createdAt: new Date(clock).toISOString(),
				renewAt: new Date(clock + 7 * day).toISOString(),
				expiresAt: new Date(clock + 14 * day).toISOString()
			});
			const row = await routing()
				.prepare('SELECT target, url, transport FROM webhook_endpoints WHERE id = ?')
				.bind(hook.id)
				.first<{ target: string; url: string; transport: string }>();
			expect(row?.transport).toBe('resthook');
			expect(row?.url).toBe(target(`renew-${principal.kind}`));
			expect(JSON.parse(row?.target ?? 'null')).toEqual({
				userId: 'r-own',
				credential: principal.kind === 'token' ? 'token:tok-own' : 'oauth:client-zap'
			});
		}
	});

	it('needs a credential and links:read; a member may subscribe', async () => {
		const body = { event: 'link.created', targetUrl: target('auth') };
		expect((await call(null, 'POST', '/hooks', body)).status).toBe(401);
		const noScope = await call(
			token('r-own', 'ws-r', 'tok-w', ['links:write']),
			'POST',
			'/hooks',
			body
		);
		expect([noScope.status, codeOf(noScope)]).toEqual([403, 'INSUFFICIENT_SCOPE']);
		expect((await call(token('r-mem', 'ws-r', 'tok-mem'), 'POST', '/hooks', body)).status).toBe(
			201
		);
		const outsider = await call(token('r-mem', 'ws-r-b', 'tok-mem'), 'POST', '/hooks', body);
		expect(outsider.status).toBe(401);
	});

	it('refuses other hosts, http, unknown events, and a workspace without webhooks', async () => {
		const principal = token('r-own', 'ws-r', 'tok-own');
		for (const [body, field] of [
			[{ event: 'link.created', targetUrl: 'https://hooks.example.com/in' }, 'targetUrl'],
			[{ event: 'link.created', targetUrl: 'http://hooks.zapier.com/hooks/x/' }, 'targetUrl'],
			[{ event: 'link.deleted', targetUrl: target('event') }, 'event'],
			[{ event: 'link.created', targetUrl: target('extra'), secret: 'x' }, 'secret']
		] as const) {
			const result = await call(principal, 'POST', '/hooks', body);
			expect([result.status, codeOf(result), fieldOf(result)]).toEqual([
				422,
				'INVALID_INPUT',
				field
			]);
		}
		const free = await call(token('r-free', 'ws-r-free', 'tok-free'), 'POST', '/hooks', {
			event: 'link.created',
			targetUrl: target('free')
		});
		expect([free.status, codeOf(free)]).toEqual([403, 'WEBHOOK_LIMIT_REACHED']);
	});

	it('answers 404 without hook settings', async () => {
		const principal = token('r-own', 'ws-r', 'tok-own');
		const id = await hookOf(principal, 'unset');
		const app = api(null);
		const body = { event: 'link.created', targetUrl: target('unset2') };
		expect((await call(principal, 'POST', '/hooks', body, app)).status).toBe(404);
		expect((await call(principal, 'DELETE', `/hooks/${id}`, undefined, app)).status).toBe(404);
	});

	it('lets a member delete their own hooks and the owner any, only in its workspace', async () => {
		const mem = token('r-mem', 'ws-r', 'tok-mem');
		const mem2 = token('r-mem2', 'ws-r', 'tok-mem2');
		const own = token('r-own', 'ws-r', 'tok-own');
		const other = token('r-b', 'ws-r-b', 'tok-b');
		const first = await hookOf(mem, 'del-1');
		const second = await hookOf(mem, 'del-2');
		expect((await call(mem2, 'DELETE', `/hooks/${first}`)).status).toBe(404);
		expect((await call(other, 'DELETE', `/hooks/${first}`)).status).toBe(404);
		expect((await call(mem, 'DELETE', `/hooks/${first}`)).status).toBe(204);
		expect((await call(own, 'DELETE', `/hooks/${second}`)).status).toBe(204);
		expect((await call(own, 'DELETE', `/hooks/${second}`)).status).toBe(404);
	});

	it('deletes hooks while suspended and refuses new ones', async () => {
		await addTenant('r-sus', 'ws-r-sus');
		const principal = token('r-sus', 'ws-r-sus', 'tok-sus');
		const id = await hookOf(principal, 'sus');
		await identity()
			.prepare(
				"UPDATE tenant_policy SET suspended_at = 1, suspended_reason = 'spam' WHERE tenant_id = ?"
			)
			.bind('ws-r-sus')
			.run();
		const refused = await call(principal, 'POST', '/hooks', {
			event: 'link.created',
			targetUrl: target('sus-2')
		});
		expect([refused.status, codeOf(refused)]).toEqual([403, 'WORKSPACE_SUSPENDED']);
		expect((await call(principal, 'DELETE', `/hooks/${id}`)).status).toBe(204);
		const viaSession = await hookOfDirect('ws-r-sus', 'r-sus');
		expect((await call(session('r-sus'), 'DELETE', `/hooks/${viaSession}`)).status).toBe(204);
	});

	// A hook made through the data layer, for a workspace whose routes refuse new hooks.
	async function hookOfDirect(tenantId: string, userId: string): Promise<string> {
		const result = await subscribeHook(routing(), {
			id: `hok_direct_${tenantId}`,
			tenantId,
			event: 'link.created',
			targetUrl: target(`direct-${tenantId}`),
			milestoneInterval: null,
			maker: { userId, credential: 'session' },
			now: clock,
			expiresAt: clock + 14 * day
		});
		// The data layer does not check suspension; the route does.
		if (result.status !== 'created') throw new Error(`Expected a created hook: ${result.status}`);
		return result.endpoint.id;
	}

	it('deletes the hooks of a revoked token, a revoked app, a removed member, and a member who left', async () => {
		await addTenant('v-own', 'ws-v');
		await addMember('v-ava', 'ws-v');
		await addMember('v-ben', 'ws-v');
		await identity()
			.prepare(
				`INSERT INTO "apikey" ("id", "name", "start", "referenceId", "key", "createdAt", "updatedAt", "metadata")
				VALUES ('tok-ava', 'Zap', 'flr_ava', 'v-ava', 'hashed-ava', 0, 0, '{"tenantId":"ws-v"}')`
			)
			.run();
		await identity().batch([
			identity().prepare(
				`INSERT INTO "oauthClient" ("id", "clientId", "redirectUris", "createdAt", "updatedAt") VALUES ('c1', 'client-zap', '["https://zapier.com/dashboard/auth/oauth/return/App1CLIAPI/"]', 0, 0)`
			),
			identity().prepare(
				`INSERT INTO "oauthConsent" ("id", "clientId", "userId", "referenceId", "scopes", "createdAt", "updatedAt") VALUES ('consent-ava', 'client-zap', 'v-ava', 'ws-v', '["links:read"]', 0, 0)`
			)
		]);
		const avaToken = await hookOf(token('v-ava', 'ws-v', 'tok-ava'), 'v-token');
		const avaOtherToken = await hookOf(token('v-ava', 'ws-v', 'tok-ava-2'), 'v-token-2');
		const avaApp = await hookOf(oauth('v-ava', 'ws-v', 'client-zap'), 'v-app');
		const benApp = await hookOf(oauth('v-ben', 'ws-v', 'client-zap'), 'v-ben-app');
		const ownerHook = await hookOf(token('v-own', 'ws-v', 'tok-own'), 'v-own');
		const live = async () =>
			(
				await routing()
					.prepare("SELECT id FROM webhook_endpoints WHERE tenant_id = 'ws-v' ORDER BY id")
					.all<{ id: string }>()
			).results.map((row) => row.id);
		const shown = { 'x-flared-workspace': 'ws-v' };

		expect(
			(await call(session('v-ava'), 'DELETE', '/tokens/tok-ava', undefined, api(), shown)).status
		).toBe(204);
		expect(await live()).toEqual([avaOtherToken, avaApp, benApp, ownerHook].sort());
		expect(
			(
				await call(
					session('v-ava'),
					'DELETE',
					'/connected-apps/client-zap',
					undefined,
					api(),
					shown
				)
			).status
		).toBe(204);
		expect(await live()).toEqual([avaOtherToken, benApp, ownerHook].sort());
		expect(
			(await call(session('v-own'), 'DELETE', '/members/v-ava', undefined, api(), shown)).status
		).toBe(204);
		expect(await live()).toEqual([benApp, ownerHook].sort());
		expect(
			(await call(session('v-ben'), 'POST', '/workspace/leave', undefined, api(), shown)).status
		).toBe(204);
		expect(await live()).toEqual([ownerHook]);
		expect(avaToken).not.toBe(ownerHook);
	});
});
