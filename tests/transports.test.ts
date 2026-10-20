// SPDX-License-Identifier: AGPL-3.0-only
// Endpoints of another transport than http against real D1 and an injected sender: the webhook
// routes see only http, the transport functions keep their cap, key, plan, and tenancy, events
// fan out to them, a round calls each sender once, off reasons and restores, pauses, the
// request-path budget, the post_message action, the top-links and link-label reads, and
// workspace deletion.
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Automation, AutomationPage } from '../packages/contracts/src/automations';
import { openApiDocument } from '../packages/contracts/src/openapi';
import type {
	CreatedWebhookEndpoint,
	WebhookEndpointPage
} from '../packages/contracts/src/webhooks';
import { readTopLinks } from '../packages/data/src/analytics';
import { claimAutomations, runAutomations } from '../packages/data/src/automations';
import { deleteRoutingData } from '../packages/data/src/deletions';
import { readLink, readLinkLabels } from '../packages/data/src/links';
import { createTenant } from '../packages/data/src/tenancy';
import {
	createTransportEndpoint,
	deleteTransportEndpoints,
	fanOutWebhookEvents,
	insertMilestoneEvents,
	insertTestEvent,
	listTransportEndpoints,
	readTransportEndpoints,
	restoreTransportEndpoints,
	stageIntegrationMessages,
	updateTransportEndpoint,
	type ClaimedDelivery,
	type DeliveryResult,
	type WebhookEndpointRow
} from '../packages/data/src/webhooks';
import {
	createApi,
	type ApiDependencies,
	type ApiPrincipal,
	type WebhookSettings
} from '../packages/server/src/api';
import { runAutomationJob } from '../packages/server/src/automations/jobs';
import { createLink } from '../packages/server/src/links';
import { mcpServerCard } from '../packages/server/src/mcp';
import { projectPolicy, updatePolicy } from '../packages/server/src/tenancy';
import {
	deliverWebhookEvent,
	runWebhookJob,
	type WebhookSendSettings,
	type WebhookTransport
} from '../packages/server/src/webhooks/deliver';
import { counting } from './support/d1-count';

const origin = 'https://app.example';
const identity = () => env.TRANSPORTS_IDENTITY;
const routing = () => env.TRANSPORTS_ROUTING;
const shard = () => env.TRANSPORTS_ANALYTICS;
const shards = () => ({ 'analytics-1': shard() });
const stores = () => ({ routing: routing(), analytics: shards() });
const start = Date.UTC(2026, 9, 17, 9, 12, 30, 123);
let clock = start;
const minute = 60000;
const hookUrl = 'https://hooks.example.com/in';
const chatUrl = 'https://chat.example/open/c1';
const rootSecret = 'test-only-transport-webhook-secret';
const baseLimits = {
	activeLinkLimit: 200,
	monthlyClickLimit: 5000,
	retentionDays: 30,
	domainLimit: 1,
	webhookEndpointLimit: 5,
	automationLimit: 25
};
const tenantOf: Record<string, string> = {};

// The signed POSTs.
let received: { body: string }[] = [];
const receiver: typeof fetch = async (_input, init = {}) => {
	received.push({ body: typeof init.body === 'string' ? init.body : '' });
	return new Response(null, { status: 204 });
};

// The edition's sender for the 'chat' transport: each call is one batch.
let calls: { deliveries: ClaimedDelivery[]; context: { now: number; concurrency: number } }[] = [];
let answer: (delivery: ClaimedDelivery) => Partial<DeliveryResult> | null = () => ({
	outcome: 'succeeded'
});
const chat: WebhookTransport = {
	async send(deliveries, context) {
		calls.push({ deliveries: [...deliveries], context });
		return deliveries.flatMap((delivery) => {
			const fields = answer(delivery);
			if (!fields) return [];
			return [
				{
					id: delivery.id,
					endpointId: delivery.endpoint.id,
					outcome: 'succeeded',
					responseStatus: null,
					errorCode: null,
					durationMs: 3,
					...fields
				}
			];
		});
	}
};
const background: Promise<unknown>[] = [];

afterEach(() => {
	received = [];
	calls = [];
	answer = () => ({ outcome: 'succeeded' });
	background.length = 0;
	clock = start;
	vi.restoreAllMocks();
});

async function addTenant(
	userId: string,
	tenantId: string,
	limits: Partial<typeof baseLimits> = {}
): Promise<void> {
	tenantOf[userId] = tenantId;
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

function api(
	options: {
		identity?: D1Database;
		routing?: D1Database;
		webhooks?: Partial<WebhookSettings>;
		automations?: ApiDependencies['automations'];
	} = {}
) {
	return createApi({
		identity: options.identity ?? identity(),
		routing: options.routing ?? routing(),
		analytics: shards(),
		appOrigin: origin,
		domains: { reservedHostnames: ['short.example'] },
		now: () => clock,
		webhooks: {
			secret: rootSecret,
			fetch: receiver,
			background: (task: Promise<unknown>) => void background.push(task),
			transports: { chat },
			...options.webhooks
		},
		automations: options.automations ?? { email: true, destinationChecks: false, messages: true },
		authenticate: async (request): Promise<ApiPrincipal | null> => {
			const userId = request.headers.get('x-test-user');
			if (!userId) return null;
			return {
				kind: 'session',
				userId,
				sessionId: `session-${userId}`,
				signedInAt: new Date(clock).toISOString()
			};
		}
	});
}

async function call(
	userId: string,
	method: string,
	path: string,
	body?: unknown,
	app = api(),
	extra: Record<string, string> = {}
): Promise<{ status: number; text: string; json: unknown }> {
	const headers: Record<string, string> = { 'x-test-user': userId, origin, ...extra };
	const init: RequestInit = { method, headers };
	if (body !== undefined) {
		init.body = JSON.stringify(body);
		headers['content-type'] = 'application/json';
	}
	const response = await app.fetch(new Request(`${origin}/v1${path}`, init));
	const text = await response.text();
	return { status: response.status, text, json: text ? JSON.parse(text) : null };
}

function codeOf(result: { json: unknown }): unknown {
	return (result.json as { error?: { code?: unknown } } | null)?.error?.code;
}

function fieldOf(result: { json: unknown }): unknown {
	return (result.json as { error?: { field?: unknown } } | null)?.error?.field;
}

async function addHttp(userId: string, events = ['link.created']): Promise<string> {
	const created = await call(userId, 'POST', '/webhooks', { url: hookUrl, events });
	expect(created.status, created.text).toBe(201);
	return (created.json as CreatedWebhookEndpoint).endpoint.id;
}

let endpointCounter = 0;
async function addTransport(
	tenantId: string,
	key: string,
	options: {
		events?: WebhookEndpointRow['events'];
		milestoneInterval?: number | null;
		transport?: string;
		limit?: number;
	} = {}
): Promise<WebhookEndpointRow> {
	endpointCounter += 1;
	const created = await createTransportEndpoint(routing(), {
		id: `whk_t${endpointCounter}`,
		tenantId,
		transport: options.transport ?? 'chat',
		targetKey: key,
		target: JSON.stringify({ channel: key }),
		url: chatUrl,
		events: options.events ?? [],
		milestoneInterval: options.milestoneInterval ?? null,
		limit: options.limit ?? 20,
		now: clock
	});
	if (created.status !== 'created')
		throw new Error(`Expected a created endpoint: ${created.status}`);
	return created.endpoint;
}

let linkCounter = 0;
async function addLink(tenantId: string, title: string | null = null): Promise<string> {
	linkCounter += 1;
	const result = await createLink(routing(), {
		tenantId,
		key: `link-${linkCounter}`,
		input: {
			destination: `https://example.com/start/${linkCounter}`,
			slug: null,
			title,
			domainId: null,
			iosDestination: null,
			androidDestination: null
		},
		requestId: 'request-1',
		now: clock
	});
	expect(result.status, result.body).toBe(201);
	return (JSON.parse(result.body) as { link: { id: string } }).link.id;
}

async function endpointRow(id: string) {
	return routing()
		.prepare(
			'SELECT enabled, off_reason, failure_count, paused_until FROM webhook_endpoints WHERE id = ?'
		)
		.bind(id)
		.first<{
			enabled: number;
			off_reason: string | null;
			failure_count: number;
			paused_until: number | null;
		}>();
}

async function deliveryRows(endpointId: string) {
	const { results } = await routing()
		.prepare(
			`SELECT d.state, d.attempts, d.error_code, e.type, e.id AS event_id FROM webhook_deliveries d
			JOIN webhook_events e ON e.id = d.event_id WHERE d.endpoint_id = ? ORDER BY d.created_at, e.id`
		)
		.bind(endpointId)
		.all<{
			state: string;
			attempts: number;
			error_code: string | null;
			type: string;
			event_id: string;
		}>();
	return results;
}

const sendSettings = (extra: Partial<WebhookSendSettings> = {}): WebhookSendSettings => ({
	secret: rootSecret,
	reservedHostnames: [],
	fetch: receiver,
	now: () => clock,
	transports: { chat },
	...extra
});

const webhookJob = (extra: Partial<WebhookSendSettings> = {}) =>
	runWebhookJob(stores(), { ...sendSettings(extra), transferMilestones: false });

// A targeted event for one endpoint, as an automation run writes it.
async function stageTargeted(tenantId: string, endpointId: string, id: string): Promise<void> {
	await routing()
		.prepare(
			"INSERT INTO webhook_events (id, tenant_id, type, target_endpoint_id, payload, created_at) VALUES (?, ?, 'automation.triggered', ?, '{}', ?)"
		)
		.bind(id, tenantId, endpointId, clock)
		.run();
}

async function runBackground(): Promise<void> {
	await Promise.all(background.splice(0));
}

async function drainAutomations(): Promise<void> {
	for (let round = 0; round < 10; round += 1)
		if (
			(
				await runAutomationJob(
					{ identity: identity(), ...stores() },
					{ email: true, now: () => clock }
				)
			).claimed === 0
		)
			return;
	throw new Error('Due applications kept coming');
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
	it('see only http endpoints, and count only them against the limit', async () => {
		await addTenant('u-iso', 't-iso', { webhookEndpointLimit: 2 });
		for (const key of ['alerts:C1', 'alerts:C2', 'automation:C3'])
			await addTransport('t-iso', key, { events: ['link.created'] });
		const http = [await addHttp('u-iso'), await addHttp('u-iso')];
		const third = await call('u-iso', 'POST', '/webhooks', {
			url: hookUrl,
			events: ['link.created']
		});
		expect([third.status, codeOf(third)]).toEqual([403, 'WEBHOOK_LIMIT_REACHED']);
		const page = (await call('u-iso', 'GET', '/webhooks')).json as WebhookEndpointPage;
		expect([page.used, page.limit]).toEqual([2, 2]);
		expect(page.endpoints.every((endpoint) => endpoint.url === hookUrl)).toBe(true);
		expect(page.endpoints.map((endpoint) => endpoint.id).sort()).toEqual(http.sort());

		const transport = await addTransport('t-iso', 'alerts:C9', { limit: 20 });
		for (const [method, path, body] of [
			['PATCH', `/webhooks/${transport.id}`, { enabled: false }],
			['DELETE', `/webhooks/${transport.id}`],
			['POST', `/webhooks/${transport.id}/secret`],
			['POST', `/webhooks/${transport.id}/test`],
			['GET', `/webhooks/${transport.id}/deliveries`]
		] as const) {
			const result = await call('u-iso', method, path, body);
			expect([result.status, codeOf(result)], `${method} ${path}`).toEqual([404, 'NOT_FOUND']);
		}
		expect(await endpointRow(transport.id)).toMatchObject({ enabled: 1, off_reason: null });
		const kept = await routing()
			.prepare('SELECT secret_version, key_id FROM webhook_endpoints WHERE id = ?')
			.bind(transport.id)
			.first();
		expect(kept).toEqual({ secret_version: 1, key_id: 'transport' });
		expect(calls).toEqual([]);
		expect(received).toEqual([]);
	});
});

describe('transport endpoints', () => {
	it('keep the cap passed in under concurrent creates, a unique target key, and the plan', async () => {
		await addTenant('u-cap', 't-cap');
		await addTenant('u-cap2', 't-cap2');
		const creates = await Promise.all(
			Array.from({ length: 6 }, (_, index) =>
				createTransportEndpoint(routing(), {
					id: `whk_cap_${index}`,
					tenantId: 't-cap',
					transport: 'chat',
					targetKey: `alerts:C${index}`,
					target: null,
					url: chatUrl,
					events: [],
					milestoneInterval: null,
					limit: 3,
					now: clock
				})
			)
		);
		expect(creates.filter((result) => result.status === 'created')).toHaveLength(3);
		expect(creates.filter((result) => result.status === 'limit')).toEqual(
			Array(3).fill({ status: 'limit', limit: 3 })
		);
		// http endpoints do not take a place.
		await addHttp('u-cap');
		await addHttp('u-cap');
		const same = (id: string, tenantId = 't-cap') =>
			createTransportEndpoint(routing(), {
				id,
				tenantId,
				transport: 'chat',
				targetKey: 'summary:C1',
				target: null,
				url: chatUrl,
				events: [],
				milestoneInterval: null,
				limit: 20,
				now: clock
			});
		const pair = await Promise.all([same('whk_same_a'), same('whk_same_b')]);
		expect(pair.map((result) => result.status).sort()).toEqual(['created', 'taken']);
		// Another workspace and another transport keep their own keys.
		expect((await same('whk_same_c', 't-cap2')).status).toBe('created');
		const mail = await createTransportEndpoint(routing(), {
			id: 'whk_mail',
			tenantId: 't-cap',
			transport: 'mail',
			targetKey: 'summary:C1',
			target: null,
			url: chatUrl,
			events: [],
			milestoneInterval: null,
			limit: 20,
			now: clock
		});
		expect(mail.status).toBe('created');

		await addTenant('u-free', 't-free', { webhookEndpointLimit: 0 });
		expect(await same('whk_free', 't-free')).toEqual({ status: 'limit', limit: 0 });
		expect(await same('whk_none', 't-none')).toEqual({ status: 'no_workspace' });
		await expect(
			createTransportEndpoint(routing(), {
				id: 'whk_http',
				tenantId: 't-cap',
				transport: 'http',
				targetKey: 'x',
				target: null,
				url: chatUrl,
				events: [],
				milestoneInterval: null,
				limit: 20,
				now: clock
			})
		).rejects.toThrow();
	});

	it('list, change, and delete only the tenant’s endpoints on the transport', async () => {
		await addTenant('u-ten', 't-ten');
		await addTenant('u-ten2', 't-ten2');
		const keys = ['alerts:C1', 'alerts:C2', 'alerts:C3', 'automation:C1'];
		const rows: WebhookEndpointRow[] = [];
		for (const key of keys) rows.push(await addTransport('t-ten', key));
		const other = await addTransport('t-ten2', 'alerts:C1');
		const keysOf = (list: WebhookEndpointRow[]) => list.map((row) => row.targetKey);
		expect(
			keysOf(
				await listTransportEndpoints(routing(), {
					transport: 'chat',
					tenantId: 't-ten',
					limit: 100
				})
			)
		).toEqual(keys);
		const page = await listTransportEndpoints(routing(), {
			transport: 'chat',
			tenantId: 't-ten',
			keyPrefix: 'alerts:',
			limit: 2
		});
		expect(keysOf(page)).toEqual(['alerts:C1', 'alerts:C2']);
		expect(
			keysOf(
				await listTransportEndpoints(routing(), {
					transport: 'chat',
					tenantId: 't-ten',
					keyPrefix: 'alerts:',
					after: 'alerts:C2',
					limit: 2
				})
			)
		).toEqual(['alerts:C3']);
		expect(
			await updateTransportEndpoint(routing(), 't-ten', 'chat', other.id, {
				enabled: false,
				now: clock
			})
		).toBeNull();
		expect(await deleteTransportEndpoints(routing(), 't-ten', 'chat', other.id)).toBe(0);
		expect((await endpointRow(other.id))?.enabled).toBe(1);
		const changed = await updateTransportEndpoint(routing(), 't-ten', 'chat', rows[0].id, {
			events: ['link.click_milestone'],
			now: clock
		});
		expect(changed).toMatchObject({ events: ['link.click_milestone'], milestoneInterval: 1000 });
		const states = await readTransportEndpoints(routing(), [rows[0].id, other.id, 'whk_missing']);
		expect(states.map((state) => [state.id, state.analyticsShardId, state.on]).sort()).toEqual(
			[
				[rows[0].id, 'analytics-1', true],
				[other.id, 'analytics-1', true]
			].sort()
		);
		expect(await deleteTransportEndpoints(routing(), 't-ten', 'chat', rows[3].id)).toBe(1);
		expect(await deleteTransportEndpoints(routing(), 't-ten', 'chat')).toBe(3);
		expect(
			await listTransportEndpoints(routing(), { transport: 'chat', tenantId: 't-ten', limit: 100 })
		).toEqual([]);
		expect((await endpointRow(other.id))?.enabled).toBe(1);
	});
});

describe('staging and fan-out', () => {
	it('stage link events for a workspace with only transport endpoints, by subscription', async () => {
		await addTenant('u-only', 't-only');
		const subscribed = await addTransport('t-only', 'alerts:C1', { events: ['link.created'] });
		const silent = await addTransport('t-only', 'automation:C1');
		const created = await call(
			'u-only',
			'POST',
			'/links',
			{ destination: 'https://example.com/a' },
			api(),
			{
				'idempotency-key': 'only-1'
			}
		);
		expect(created.status, created.text).toBe(201);
		expect(background).toHaveLength(1);
		await runBackground();
		expect(calls).toHaveLength(1);
		expect(
			calls[0].deliveries.map((delivery) => [delivery.endpoint.id, delivery.event.type])
		).toEqual([[subscribed.id, 'link.created']]);
		expect(calls[0].deliveries[0].endpoint).toMatchObject({
			transport: 'chat',
			target: JSON.stringify({ channel: 'alerts:C1' }),
			url: chatUrl
		});
		expect(calls[0].context).toEqual({ now: clock, concurrency: 5 });
		expect(await deliveryRows(subscribed.id)).toMatchObject([{ state: 'succeeded', attempts: 1 }]);
		expect(await deliveryRows(silent.id)).toEqual([]);
		expect(received).toEqual([]);

		// Off at limit 0: nothing is staged, so nothing runs after the change.
		await updatePolicy(
			identity(),
			stores(),
			't-only',
			{ ...baseLimits, webhookEndpointLimit: 0 },
			clock
		);
		const later = await call(
			'u-only',
			'POST',
			'/links',
			{ destination: 'https://example.com/b' },
			api(),
			{
				'idempotency-key': 'only-2'
			}
		);
		expect(later.status).toBe(201);
		expect(background).toHaveLength(0);
	});

	it('turn milestones into events for a transport endpoint whose interval divides the clicks', async () => {
		await addTenant('u-mile', 't-mile');
		const endpoint = await addTransport('t-mile', 'alerts:C1', {
			events: ['link.click_milestone'],
			milestoneInterval: 200
		});
		const linkId = await addLink('t-mile');
		const milestone = (clicks: number) => ({
			id: `link.click_milestone:${linkId}:${clicks}`,
			tenantId: 't-mile',
			linkId,
			clicks,
			createdAt: clock
		});
		expect(await insertMilestoneEvents(routing(), [milestone(100)])).toBe(0);
		expect(await insertMilestoneEvents(routing(), [milestone(200)])).toBe(1);
		await webhookJob();
		expect(calls).toHaveLength(1);
		expect(calls[0].deliveries.map((delivery) => delivery.event.type)).toEqual([
			'link.click_milestone'
		]);
		expect(JSON.parse(calls[0].deliveries[0].event.payload)).toMatchObject({ clicks: 200 });
		expect(await deliveryRows(endpoint.id)).toMatchObject([{ state: 'succeeded' }]);
	});

	it('stage integration messages only for enabled transport endpoints of a workspace that has webhooks on', async () => {
		await addTenant('u-msg', 't-msg');
		await addTenant('u-msg2', 't-msg2');
		await addTenant('u-msg3', 't-msg3', { webhookEndpointLimit: 0 });
		const on = await addTransport('t-msg', 'summary:C1');
		const off = await addTransport('t-msg', 'summary:C2');
		await updateTransportEndpoint(routing(), 't-msg', 'chat', off.id, {
			enabled: false,
			now: clock
		});
		const http = await addHttp('u-msg');
		const otherTenant = await addTransport('t-msg2', 'summary:C1');
		await routing()
			.prepare(
				"INSERT INTO webhook_endpoints (id, tenant_id, transport, target_key, url, events, key_id, created_at, updated_at) VALUES ('whk_plan0', 't-msg3', 'chat', 'summary:C1', ?, '[]', 'transport', 1, 1)"
			)
			.bind(chatUrl)
			.run();
		const message = (id: string, tenantId: string, endpointId: string) => ({
			id,
			tenantId,
			endpointId,
			payload: JSON.stringify({ kind: 'weekly_summary', clicks: 12 }),
			createdAt: clock
		});
		const items = [
			message('evt_sum_on', 't-msg', on.id),
			message('evt_sum_off', 't-msg', off.id),
			message('evt_sum_http', 't-msg', http),
			message('evt_sum_cross', 't-msg', otherTenant.id),
			message('evt_sum_plan', 't-msg3', 'whk_plan0')
		];
		expect(await stageIntegrationMessages(routing(), items)).toBe(1);
		expect(await stageIntegrationMessages(routing(), items)).toBe(0);
		// An integration message that targets an http endpoint gets no delivery.
		await routing()
			.prepare(
				"INSERT INTO webhook_events (id, tenant_id, type, target_endpoint_id, payload, created_at) VALUES ('evt_raw_http', 't-msg', 'integration.message', ?, '{}', ?)"
			)
			.bind(http, clock)
			.run();
		await webhookJob();
		expect(calls).toHaveLength(1);
		expect(calls[0].deliveries.map((delivery) => [delivery.event.id, delivery.event.type])).toEqual(
			[['evt_sum_on', 'integration.message']]
		);
		expect(await deliveryRows(http)).toEqual([]);
		expect(received).toEqual([]);

		// The http sender refuses one anyway, without a request.
		await routing().batch([
			routing()
				.prepare(
					"INSERT INTO webhook_events (id, tenant_id, type, target_endpoint_id, payload, created_at, fanned_out_at) VALUES ('evt_forced', 't-msg', 'integration.message', ?, '{}', ?, ?)"
				)
				.bind(http, clock, clock),
			routing()
				.prepare(
					"INSERT INTO webhook_deliveries (id, tenant_id, event_id, endpoint_id, next_attempt_at, created_at) VALUES ('dlv_forced', 't-msg', 'evt_forced', ?, ?, ?)"
				)
				.bind(http, clock, clock)
		]);
		await webhookJob();
		expect(received).toEqual([]);
		expect(await deliveryRows(http)).toMatchObject([
			{ event_id: 'evt_forced', state: 'skipped', error_code: 'disabled' }
		]);
	});
});

describe('dispatch', () => {
	it('call each sender once a round, fail a transport without one, and retry a delivery without a result', async () => {
		await addTenant('u-disp', 't-disp');
		const http = await addHttp('u-disp');
		const rows = [
			await addTransport('t-disp', 'alerts:C1'),
			await addTransport('t-disp', 'alerts:C2'),
			await addTransport('t-disp', 'alerts:C3'),
			await addTransport('t-disp', 'alerts:C4')
		];
		const mail = await addTransport('t-disp', 'alerts:M1', { transport: 'mail' });
		await stageTargeted('t-disp', http, 'evt_d_http');
		for (const [index, row] of rows.entries())
			await stageTargeted('t-disp', row.id, `evt_d_${index}`);
		await stageTargeted('t-disp', mail.id, 'evt_d_mail');
		// The sender answers the first, leaves out the second, names a delivery it was not given,
		// and gives the fourth a negative duration.
		answer = (delivery) =>
			delivery.endpoint.id === rows[1].id
				? null
				: delivery.endpoint.id === rows[2].id
					? { id: 'dlv_not_given', outcome: 'succeeded' }
					: delivery.endpoint.id === rows[3].id
						? { outcome: 'failed', errorCode: 'rejected', durationMs: -1 }
						: { outcome: 'succeeded' };
		const run = await webhookJob();
		expect(run).toMatchObject({ sent: 6, succeeded: 2 });
		expect(calls).toHaveLength(1);
		expect(calls[0].deliveries.map((delivery) => delivery.endpoint.id).sort()).toEqual(
			rows.map((row) => row.id).sort()
		);
		expect(received).toHaveLength(1);
		expect(await deliveryRows(rows[0].id)).toMatchObject([{ state: 'succeeded' }]);
		for (const row of rows.slice(1))
			expect(await deliveryRows(row.id)).toMatchObject([
				{ state: 'pending', attempts: 1, error_code: 'network' }
			]);
		expect(await deliveryRows(mail.id)).toMatchObject([
			{ state: 'failed', attempts: 1, error_code: 'transport_missing' }
		]);

		// A sender that throws leaves its deliveries for a retry; http still goes out.
		clock += 2 * minute;
		await stageTargeted('t-disp', http, 'evt_d_http_2');
		const failing: WebhookTransport = {
			send: async () => {
				throw new Error('down');
			}
		};
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const second = await webhookJob({ transports: { chat: failing } });
		expect(second).toMatchObject({ sent: 4, succeeded: 1 });
		for (const row of rows.slice(1))
			expect(await deliveryRows(row.id)).toMatchObject([
				{ state: 'pending', attempts: 2, error_code: 'network' }
			]);
	});

	it('skip a delivery turned off after the fan-out without a call, and send a test to an endpoint that is off', async () => {
		await addTenant('u-skip', 't-skip');
		const row = await addTransport('t-skip', 'automation:C1');
		await stageTargeted('t-skip', row.id, 'evt_s_1');
		await fanOutWebhookEvents(routing(), { now: clock, limit: 100, tenantId: 't-skip' });
		await updateTransportEndpoint(routing(), 't-skip', 'chat', row.id, {
			enabled: false,
			now: clock
		});
		await webhookJob();
		expect(calls).toEqual([]);
		expect(await deliveryRows(row.id)).toMatchObject([
			{ state: 'skipped', error_code: 'disabled' }
		]);
		expect(
			await insertTestEvent(routing(), {
				id: 'evt_s_test',
				tenantId: 't-skip',
				endpointId: row.id,
				payload: '{}',
				now: clock,
				transport: 'chat'
			})
		).toBe(true);
		const sent = await deliverWebhookEvent(routing(), 't-skip', 'evt_s_test', sendSettings());
		expect(sent).toMatchObject({ sent: 1, succeeded: 1 });
		expect(calls.map((item) => item.deliveries.map((delivery) => delivery.event.type))).toEqual([
			['webhook.test']
		]);
	});
});

describe('off reasons and pauses', () => {
	it('turn off one endpoint for target_unavailable and the transport’s endpoints for unauthorized, then restore', async () => {
		await addTenant('u-off', 't-off');
		await addTenant('u-off2', 't-off2');
		const http = await addHttp('u-off');
		const [a, b, c] = [
			await addTransport('t-off', 'alerts:C1'),
			await addTransport('t-off', 'alerts:C2'),
			await addTransport('t-off', 'automation:C3')
		];
		const mail = await addTransport('t-off', 'alerts:M1', { transport: 'mail' });
		const other = await addTransport('t-off2', 'alerts:C1');
		await stageTargeted('t-off', a.id, 'evt_o_a');
		answer = () => ({ outcome: 'failed', errorCode: 'target_unavailable' });
		await webhookJob();
		expect(await endpointRow(a.id)).toMatchObject({ enabled: 0, off_reason: 'target_unavailable' });
		for (const id of [b.id, c.id, other.id, http, mail.id])
			expect(await endpointRow(id)).toMatchObject({ enabled: 1, off_reason: null });

		await stageTargeted('t-off', b.id, 'evt_o_b');
		answer = () => ({ outcome: 'failed', errorCode: 'unauthorized' });
		await webhookJob({ transports: { chat, mail: chat } });
		for (const id of [b.id, c.id])
			expect(await endpointRow(id)).toMatchObject({ enabled: 0, off_reason: 'unauthorized' });
		expect(await endpointRow(a.id)).toMatchObject({ off_reason: 'target_unavailable' });
		for (const id of [other.id, http, mail.id])
			expect(await endpointRow(id)).toMatchObject({ enabled: 1, off_reason: null });

		expect(await restoreTransportEndpoints(routing(), 't-off', 'chat', clock)).toBe(2);
		for (const id of [b.id, c.id])
			expect(await endpointRow(id)).toMatchObject({ enabled: 1, off_reason: null });
		expect(await endpointRow(a.id)).toMatchObject({ enabled: 0, off_reason: 'target_unavailable' });
		const turnedOn = await updateTransportEndpoint(routing(), 't-off', 'chat', a.id, {
			enabled: true,
			now: clock
		});
		expect(turnedOn).toMatchObject({ enabled: true, offReason: null });
		// Restoring again turns on nothing the owner or a target turned off.
		await updateTransportEndpoint(routing(), 't-off', 'chat', c.id, { enabled: false, now: clock });
		expect(await restoreTransportEndpoints(routing(), 't-off', 'chat', clock)).toBe(0);
		expect(await endpointRow(c.id)).toMatchObject({ enabled: 0, off_reason: null });
	});

	it('retry rate_limited without a pause, and pause the endpoint for http_status', async () => {
		await addTenant('u-rate', 't-rate');
		const limited = await addTransport('t-rate', 'alerts:C1');
		const failing = await addTransport('t-rate', 'alerts:C2');
		await stageTargeted('t-rate', limited.id, 'evt_r_1');
		await stageTargeted('t-rate', failing.id, 'evt_r_2');
		answer = (delivery) =>
			delivery.endpoint.id === limited.id
				? { outcome: 'retry', errorCode: 'rate_limited' }
				: { outcome: 'retry', errorCode: 'http_status', responseStatus: 503 };
		await webhookJob();
		expect(await endpointRow(limited.id)).toEqual({
			enabled: 1,
			off_reason: null,
			failure_count: 0,
			paused_until: null
		});
		expect(await endpointRow(failing.id)).toEqual({
			enabled: 1,
			off_reason: null,
			failure_count: 1,
			paused_until: clock + minute
		});
		expect(await deliveryRows(limited.id)).toMatchObject([
			{ state: 'pending', error_code: 'rate_limited' }
		]);
	});
});

describe('request path', () => {
	it('sends a transport endpoint’s delivery after a change within the http statement budget', async () => {
		await addTenant('u-req', 't-req');
		await addTransport('t-req', 'alerts:C1', { events: ['link.created'] });
		const counter = { queries: 0 };
		const counted = api({
			identity: counting(identity(), counter),
			routing: counting(routing(), counter)
		});
		const created = await call(
			'u-req',
			'POST',
			'/links',
			{ title: 'First', destination: 'https://example.com/a' },
			counted,
			{
				'idempotency-key': 'req-1'
			}
		);
		expect(created.status).toBe(201);
		await runBackground();
		expect(calls).toHaveLength(1);
		// The same as a signed POST: a create 13, then the fan-out batch of 3, the claim, the read,
		// and the result batch of 2.
		expect(counter.queries).toBe(20);
	});
});

describe('post_message', () => {
	it('is offered only with messages, and names a transport endpoint of the workspace', async () => {
		await addTenant('u-pm', 't-pm');
		await addTenant('u-pm2', 't-pm2');
		const http = await addHttp('u-pm');
		const target = await addTransport('t-pm', 'automation:C1');
		const foreign = await addTransport('t-pm2', 'automation:C1');
		const page = (await call('u-pm', 'GET', '/automations')).json as AutomationPage;
		expect(page.actionTypes).toEqual([
			'change_destination',
			'disable_link',
			'send_webhook',
			'post_message',
			'email_owner'
		]);
		const without = api({ automations: { email: true, destinationChecks: false } });
		expect(
			((await call('u-pm', 'GET', '/automations', undefined, without)).json as AutomationPage)
				.actionTypes
		).not.toContain('post_message');
		const create = (actions: unknown[], app = api()) =>
			call(
				'u-pm',
				'POST',
				'/automations',
				{ name: 'Post', trigger: { type: 'end_date' }, actions },
				app
			);
		const refused = await create([{ type: 'post_message', endpointId: target.id }], without);
		expect([refused.status, codeOf(refused)]).toEqual([422, 'INVALID_INPUT']);
		for (const actions of [
			[{ type: 'post_message', endpointId: http }],
			[{ type: 'post_message', endpointId: foreign.id }],
			[{ type: 'send_webhook', endpointId: target.id }]
		]) {
			const result = await create(actions);
			expect([result.status, codeOf(result), fieldOf(result)], JSON.stringify(actions)).toEqual([
				422,
				'INVALID_INPUT',
				'endpointId'
			]);
		}
		const created = await create([
			{ type: 'email_owner' },
			{ type: 'post_message', endpointId: target.id },
			{ type: 'send_webhook', endpointId: http },
			{ type: 'disable_link' },
			{ type: 'change_destination', destination: 'https://example.com/over' }
		]);
		expect(created.status, created.text).toBe(201);
		const automation = (created.json as { automation: Automation }).automation;
		expect(automation.actions.map((action) => action.type)).toEqual([
			'change_destination',
			'disable_link',
			'send_webhook',
			'post_message',
			'email_owner'
		]);
		const patch = (actions: unknown[]) =>
			call('u-pm', 'PATCH', `/automations/${automation.id}`, { actions });
		const badPatch = await patch([{ type: 'post_message', endpointId: http }]);
		expect([badPatch.status, fieldOf(badPatch)]).toEqual([422, 'endpointId']);
		const goodPatch = await patch([{ type: 'post_message', endpointId: target.id }]);
		expect(goodPatch.status, goodPatch.text).toBe(200);
		expect((goodPatch.json as { automation: Automation }).automation.actions).toEqual([
			{ type: 'post_message', endpointId: target.id }
		]);
	});

	it('writes one targeted event for each endpoint with its own ID, and records target_missing and webhooks_off', async () => {
		await addTenant('u-run', 't-run');
		await drainAutomations();
		const http = await addHttp('u-run', ['link.enabled']);
		const target = await addTransport('t-run', 'automation:C1');
		const created = await call('u-run', 'POST', '/automations', {
			name: 'Sale over',
			trigger: { type: 'end_date' },
			actions: [
				{ type: 'disable_link' },
				{ type: 'send_webhook', endpointId: http },
				{ type: 'post_message', endpointId: target.id }
			]
		});
		expect(created.status, created.text).toBe(201);
		const automation = (created.json as { automation: Automation }).automation;
		const past = () => new Date(clock - minute).toISOString();
		const apply = async (linkId: string) => {
			const result = await call('u-run', 'PUT', `/links/${linkId}/automations/${automation.id}`, {
				endsAt: past()
			});
			expect(result.status, result.text).toBe(200);
		};
		const first = await addLink('t-run');
		await apply(first);
		const counter = { queries: 0 };
		const claim = await claimAutomations(routing(), { token: 'claim-run', now: clock, limit: 10 });
		expect(claim.claimed.map((item) => item.linkId)).toEqual([first]);
		const ran = await runAutomations(counting(routing(), counter), {
			token: 'claim-run',
			now: clock,
			items: claim.claimed.map(({ linkId, automationId }) => ({
				linkId,
				automationId,
				linkEventId: 'evt_run_link',
				triggerEventId: 'evt_run_trigger',
				messageEventId: 'evt_run_message',
				runId: 'run_1'
			}))
		});
		expect(ran.ran).toBe(1);
		expect(counter.queries).toBe(8);
		const { results: events } = await routing()
			.prepare(
				"SELECT id, target_endpoint_id, payload FROM webhook_events WHERE tenant_id = 't-run' AND type = 'automation.triggered' ORDER BY id"
			)
			.all<{ id: string; target_endpoint_id: string; payload: string }>();
		expect(events.map((event) => [event.id, event.target_endpoint_id])).toEqual([
			['evt_run_message', target.id],
			['evt_run_trigger', http]
		]);
		expect(events[0].payload).toBe(events[1].payload);
		expect(JSON.parse(events[0].payload).actions).toEqual([
			'disable_link',
			'send_webhook',
			'post_message'
		]);
		await webhookJob();
		expect(received.map((request) => JSON.parse(request.body).id)).toEqual(['evt_run_trigger']);
		expect(calls.flatMap((item) => item.deliveries.map((delivery) => delivery.event.id))).toEqual([
			'evt_run_message'
		]);
		const runRow = await routing()
			.prepare("SELECT state, result_code, actions FROM automation_runs WHERE id = 'run_1'")
			.first<{ state: string; result_code: string | null; actions: string }>();
		expect(runRow).toEqual({
			state: 'succeeded',
			result_code: null,
			actions: JSON.stringify(['disable_link', 'send_webhook', 'post_message'])
		});

		// The target is gone: the link action still runs, and the application records target_missing.
		expect(await deleteTransportEndpoints(routing(), 't-run', 'chat', target.id)).toBe(1);
		const second = await addLink('t-run');
		clock += minute;
		await apply(second);
		await drainAutomations();
		const result = (linkId: string) =>
			routing()
				.prepare(
					'SELECT state, result_code FROM link_automations WHERE link_id = ? AND automation_id = ?'
				)
				.bind(linkId, automation.id)
				.first();
		expect(await result(second)).toEqual({ state: 'failed', result_code: 'target_missing' });
		expect((await readLink(routing(), 't-run', second))?.active).toBe(false);
		const targets = async () =>
			(
				await routing()
					.prepare(
						"SELECT target_endpoint_id AS target FROM webhook_events WHERE tenant_id = 't-run' AND type = 'automation.triggered' ORDER BY created_at, id"
					)
					.all<{ target: string }>()
			).results.map((row) => row.target);
		// The webhook still goes to its endpoint; the message has none.
		expect(await targets()).toEqual([target.id, http, http]);

		// Webhooks off: the endpoint exists, and no event is written.
		const again = await addTransport('t-run', 'automation:C2');
		const patched = await call('u-run', 'PATCH', `/automations/${automation.id}`, {
			actions: [{ type: 'disable_link' }, { type: 'post_message', endpointId: again.id }]
		});
		expect(patched.status, patched.text).toBe(200);
		await updatePolicy(
			identity(),
			stores(),
			't-run',
			{ ...baseLimits, webhookEndpointLimit: 0 },
			clock
		);
		const third = await addLink('t-run');
		clock += minute;
		await apply(third);
		await drainAutomations();
		expect(await result(third)).toEqual({ state: 'failed', result_code: 'webhooks_off' });
		expect((await readLink(routing(), 't-run', third))?.active).toBe(false);
		expect(await targets()).toEqual([target.id, http, http]);
	});
});

describe('contracts', () => {
	it('describe OpenAPI 1.9.0 with post_message and target_missing, and keep the 15 MCP tools', () => {
		const document = openApiDocument('https://api.example/v1');
		expect(document.info.version).toBe('1.9.0');
		expect(
			document.components.schemas.AutomationAction.oneOf.map((item) =>
				Reflect.get(Object(item.properties.type), 'const')
			)
		).toEqual([
			'change_destination',
			'disable_link',
			'send_webhook',
			'post_message',
			'email_owner'
		]);
		expect(JSON.stringify(document.components.schemas.LinkAutomation)).toContain('target_missing');
		expect(mcpServerCard('https://api.example/mcp').tools).toEqual([
			'list_links',
			'get_link',
			'get_link_qr',
			'get_link_analytics',
			'get_usage',
			'list_domains',
			'export_links',
			'list_automations',
			'create_link',
			'import_links',
			'update_link',
			'disable_link',
			'enable_link',
			'apply_automation',
			'remove_automation'
		]);
	});
});

describe('summary reads', () => {
	it('read the top links per tenant with totals for the period and the one before', async () => {
		const rows: [string, string, string, number][] = [
			['t-top1', 'lnk_a', '2026-10-12', 5],
			['t-top1', 'lnk_a', '2026-10-18', 5],
			['t-top1', 'lnk_b', '2026-10-15', 10],
			['t-top1', 'lnk_c', '2026-10-14', 7],
			['t-top1', 'lnk_d', '2026-10-13', 3],
			['t-top1', 'lnk_e', '2026-10-08', 40],
			['t-top1', 'lnk_f', '2026-10-19', 99],
			['t-top1', 'lnk_g', '2026-10-04', 99],
			['t-top2', 'lnk_z', '2026-10-16', 2],
			['t-top3', 'lnk_y', '2026-10-16', 50]
		];
		await shard().batch(
			rows.map(([tenantId, linkId, day, clicks]) =>
				shard()
					.prepare('INSERT INTO daily_totals (tenant_id, link_id, day, clicks) VALUES (?, ?, ?, ?)')
					.bind(tenantId, linkId, day, clicks)
			)
		);
		const period = { from: '2026-10-12', to: '2026-10-18', previousFrom: '2026-10-05' };
		const tops = await readTopLinks(shard(), {
			tenantIds: ['t-top1', 't-top2', 't-top-empty'],
			...period,
			limit: 2
		});
		// lnk_a and lnk_b tie at 10; the link ID breaks the tie.
		expect(tops.get('t-top1')).toEqual({
			clicks: 30,
			previousClicks: 40,
			links: [
				{ linkId: 'lnk_a', clicks: 10 },
				{ linkId: 'lnk_b', clicks: 10 }
			]
		});
		expect(tops.get('t-top2')).toEqual({
			clicks: 2,
			previousClicks: 0,
			links: [{ linkId: 'lnk_z', clicks: 2 }]
		});
		expect(tops.get('t-top-empty')).toEqual({ clicks: 0, previousClicks: 0, links: [] });
		expect(tops.has('t-top3')).toBe(false);
		// A link with clicks only in the period before is left out of the links.
		const previousOnly = await readTopLinks(shard(), {
			tenantIds: ['t-top1'],
			...period,
			limit: 10
		});
		expect(previousOnly.get('t-top1')?.links.map((link) => link.linkId)).toEqual([
			'lnk_a',
			'lnk_b',
			'lnk_c',
			'lnk_d'
		]);
		expect(await readTopLinks(shard(), { tenantIds: [], ...period, limit: 5 })).toEqual(new Map());
		const tooMany = Array.from({ length: 21 }, (_, index) => `t-${index}`);
		for (const options of [
			{ tenantIds: tooMany, ...period, limit: 5 },
			{ tenantIds: ['t-top1'], ...period, limit: 0 },
			{ tenantIds: ['t-top1'], ...period, limit: 11 },
			{ tenantIds: ['t-top1'], ...period, from: '2026-10-1', limit: 5 },
			{ tenantIds: ['t-top1'], ...period, previousFrom: '2026-10-12', limit: 5 },
			{ tenantIds: ['t-top1'], ...period, to: '2026-10-11', limit: 5 }
		])
			await expect(readTopLinks(shard(), options), JSON.stringify(options)).rejects.toThrow();
	});

	it('read link labels across tenants, leaving out a link of another tenant', async () => {
		await addTenant('u-lab', 't-lab');
		await addTenant('u-lab2', 't-lab2');
		const titled = await addLink('t-lab', 'Spring sale');
		const untitled = await addLink('t-lab');
		const other = await addLink('t-lab2', 'Other');
		const labels = await readLinkLabels(routing(), [
			{ tenantId: 't-lab', linkId: titled },
			{ tenantId: 't-lab', linkId: untitled },
			{ tenantId: 't-lab', linkId: other },
			{ tenantId: 't-lab2', linkId: other }
		]);
		const slugOf = async (tenantId: string, linkId: string) =>
			(await readLink(routing(), tenantId, linkId))?.slug;
		expect(
			labels.sort((a, b) => a.id.localeCompare(b.id) || a.tenantId.localeCompare(b.tenantId))
		).toEqual(
			[
				{
					id: titled,
					tenantId: 't-lab',
					shortUrl: `https://short.example/${await slugOf('t-lab', titled)}`,
					title: 'Spring sale'
				},
				{
					id: untitled,
					tenantId: 't-lab',
					shortUrl: `https://short.example/${await slugOf('t-lab', untitled)}`,
					title: null
				},
				{
					id: other,
					tenantId: 't-lab2',
					shortUrl: `https://short.example/${await slugOf('t-lab2', other)}`,
					title: 'Other'
				}
			].sort((a, b) => a.id.localeCompare(b.id) || a.tenantId.localeCompare(b.tenantId))
		);
		expect(await readLinkLabels(routing(), [])).toEqual([]);
		await expect(
			readLinkLabels(
				routing(),
				Array.from({ length: 501 }, () => ({ tenantId: 't-lab', linkId: titled }))
			)
		).rejects.toThrow();
	});
});

describe('workspace deletion', () => {
	it('removes transport endpoints with their deliveries and events', async () => {
		await addTenant('u-del', 't-del');
		await addTenant('u-keep', 't-keep');
		const rows = [
			await addTransport('t-del', 'alerts:C1'),
			await addTransport('t-del', 'summary:C1')
		];
		const kept = await addTransport('t-keep', 'alerts:C1');
		for (const [index, row] of rows.entries())
			await stageTargeted('t-del', row.id, `evt_del_${index}`);
		await stageTargeted('t-keep', kept.id, 'evt_keep');
		await webhookJob();
		const counts = (tenantId: string) =>
			routing()
				.prepare(
					`SELECT (SELECT COUNT(*) FROM webhook_endpoints WHERE tenant_id = ?1) AS endpoints,
						(SELECT COUNT(*) FROM webhook_deliveries WHERE tenant_id = ?1) AS deliveries,
						(SELECT COUNT(*) FROM webhook_events WHERE tenant_id = ?1) AS events`
				)
				.bind(tenantId)
				.first();
		expect(await counts('t-del')).toEqual({ endpoints: 2, deliveries: 2, events: 2 });
		for (let round = 0; round < 10; round += 1)
			if ((await deleteRoutingData(routing(), 't-del', 100)) === 0) break;
		expect(await counts('t-del')).toEqual({ endpoints: 0, deliveries: 0, events: 0 });
		expect(await counts('t-keep')).toEqual({ endpoints: 1, deliveries: 1, events: 1 });
	});
});
