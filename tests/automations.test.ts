// SPDX-License-Identifier: AGPL-3.0-only
// Automations against real D1: tenancy and roles on every route, limits under concurrency, the
// once-only run, claims, conditions already met, click marks, actions with their webhook events
// and email notices, refusals, suspension, attempts, run records, workspace deletion, the policy
// heal, and the D1 statements of each path.
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
	ApplyAutomationLinksResult,
	ApplyLinkAutomationResult,
	Automation,
	AutomationPage,
	AutomationRunPage,
	LinkAutomationPage
} from '../packages/contracts/src/automations';
import { isTokenScope, scopePresets } from '../packages/contracts/src/tokens';
import type { CreatedWebhookEndpoint, WebhookDelivery } from '../packages/contracts/src/webhooks';
import {
	claimAutomations,
	markClickApplications,
	runAutomations
} from '../packages/data/src/automations';
import { deleteRoutingData } from '../packages/data/src/deletions';
import { readLink, setLinkBlock } from '../packages/data/src/links';
import { claimNotices } from '../packages/data/src/notices';
import { applyRoutingPolicy } from '../packages/data/src/routing-policy';
import { createTenant, type PolicyLimits } from '../packages/data/src/tenancy';
import { milestoneEventsStatement, type ClickMilestone } from '../packages/data/src/webhooks';
import { createApi, type ApiDependencies, type ApiPrincipal } from '../packages/server/src/api';
import {
	cleanupAutomations,
	runAutomationJob,
	type AutomationJobOptions
} from '../packages/server/src/automations/jobs';
import { transferClickMilestones } from '../packages/server/src/automations/milestones';
import { automationNoticeEmail } from '../packages/server/src/automations/notices';
import { createLink, toApiLink } from '../packages/server/src/links';
import { reinstateTenant, suspendTenant } from '../packages/server/src/operator';
import { projectPolicy, retryProjections, updatePolicy } from '../packages/server/src/tenancy';
import { runWebhookJob } from '../packages/server/src/webhooks/deliver';
import { counting } from './support/d1-count';

const origin = 'https://app.example';
const identity = () => env.AUTOMATIONS_IDENTITY;
const routing = () => env.AUTOMATIONS_ROUTING;
const shard = () => env.AUTOMATIONS_ANALYTICS;
const shards = () => ({ 'analytics-1': shard() });
const policyStores = () => ({ routing: routing(), analytics: shards() });
const jobStores = () => ({ identity: identity(), routing: routing(), analytics: shards() });
const start = Date.UTC(2026, 9, 17, 9, 12, 30, 123);
let clock = start;
const minute = 60000;
const day = 86400000;
const hookUrl = 'https://hooks.example.com/in';
const rootSecret = 'test-only-automation-webhook-secret';
const operator = { kind: 'operator', id: 'admin-1' } as const;

const baseLimits = {
	activeLinkLimit: 200,
	monthlyClickLimit: 5000,
	retentionDays: 30,
	domainLimit: 1,
	webhookEndpointLimit: 5
};
const tenantOf: Record<string, string> = {};

interface Received {
	headers: Headers;
	body: string;
}
let received: Received[] = [];
let answer: () => Response = () => new Response(null, { status: 204 });
const receiver: typeof fetch = async (_input, init = {}) => {
	received.push({
		headers: new Headers(init.headers),
		body: typeof init.body === 'string' ? init.body : ''
	});
	return answer();
};

afterEach(() => {
	received = [];
	answer = () => new Response(null, { status: 204 });
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

async function addTenant(userId: string, tenantId: string, automationLimit = 25): Promise<void> {
	tenantOf[userId] = tenantId;
	await addUser(userId);
	await createTenant(identity(), {
		id: tenantId,
		name: 'Workspace',
		ownerUserId: userId,
		analyticsShardId: 'analytics-1',
		limits: { ...baseLimits, automationLimit },
		now: 1
	});
	await projectPolicy(identity(), policyStores(), tenantId, 1);
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

async function setLimits(tenantId: string, change: Partial<PolicyLimits>): Promise<void> {
	const result = await updatePolicy(
		identity(),
		policyStores(),
		tenantId,
		{ ...baseLimits, ...change },
		clock
	);
	expect(result.projected).toBe(true);
}

// x-test-scopes makes the principal an API token, x-test-oauth a connected app; without them, a
// dashboard session signed in now.
function api(
	options: {
		automations?: ApiDependencies['automations'] | null;
		identity?: D1Database;
		routing?: D1Database;
		analytics?: Record<string, D1Database>;
	} = {}
) {
	return createApi({
		identity: options.identity ?? identity(),
		routing: options.routing ?? routing(),
		analytics: options.analytics ?? shards(),
		appOrigin: origin,
		domains: { reservedHostnames: ['short.example'] },
		now: () => clock,
		automations:
			options.automations === null
				? undefined
				: (options.automations ?? { email: true, destinationChecks: false }),
		webhooks: { secret: rootSecret, fetch: receiver },
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

function messageOf(result: { json: unknown }): unknown {
	const body = result.json as { error?: { message?: unknown } } | null;
	return body?.error?.message;
}

const disable = { trigger: { type: 'end_date' }, actions: [{ type: 'disable_link' }] };

async function template(
	userId: string,
	input: Record<string, unknown>,
	app = api()
): Promise<Automation> {
	const created = await call(userId, 'POST', '/automations', { name: 'Template', ...input }, app);
	expect(created.status, created.text).toBe(201);
	return (created.json as { automation: Automation }).automation;
}

let linkCounter = 0;
async function addLink(tenantId: string, createdAt = clock): Promise<string> {
	linkCounter += 1;
	const result = await createLink(routing(), {
		tenantId,
		key: `link-${linkCounter}`,
		input: {
			destination: `https://example.com/start/${linkCounter}`,
			slug: null,
			title: null,
			domainId: null,
			iosDestination: null,
			androidDestination: null,
			startsAt: null,
			endsAt: null,
			endedDestination: null,
			password: null
		},
		requestId: 'request-1',
		now: createdAt
	});
	expect(result.status, result.body).toBe(201);
	return (JSON.parse(result.body) as { link: { id: string } }).link.id;
}

async function apiLink(tenantId: string, linkId: string) {
	const row = await readLink(routing(), tenantId, linkId);
	if (!row) throw new Error('Expected the link');
	return toApiLink(row);
}

const past = () => new Date(clock - minute).toISOString();
const future = () => new Date(clock + day).toISOString();

function put(
	userId: string,
	linkId: string,
	automationId: string,
	body?: unknown,
	app = api(),
	extra: Record<string, string> = {}
) {
	return call(userId, 'PUT', `/links/${linkId}/automations/${automationId}`, body, app, extra);
}

interface ApplicationRow {
	state: string;
	result_code: string | null;
	due_at: number | null;
	reached_clicks: number | null;
	armed_at: number;
	attempts: number;
	claim_token: string | null;
	fired_at: number | null;
}

async function application(linkId: string, automationId: string): Promise<ApplicationRow | null> {
	return routing()
		.prepare(
			'SELECT state, result_code, due_at, reached_clicks, armed_at, attempts, claim_token, fired_at FROM link_automations WHERE link_id = ? AND automation_id = ?'
		)
		.bind(linkId, automationId)
		.first<ApplicationRow>();
}

async function runRecords(automationId: string) {
	const { results } = await routing()
		.prepare(
			'SELECT tenant_id, link_id, state, result_code, actions, email FROM automation_runs WHERE automation_id = ? ORDER BY created_at, id'
		)
		.bind(automationId)
		.all<{
			tenant_id: string;
			link_id: string;
			state: string;
			result_code: string | null;
			actions: string;
			email: number;
		}>();
	return results.map((row) => ({ ...row, actions: JSON.parse(row.actions) as string[] }));
}

const job = (options: Partial<AutomationJobOptions> = {}) =>
	runAutomationJob(jobStores(), { email: true, now: () => clock, ...options });

const webhookJob = () =>
	runWebhookJob(policyStores(), {
		secret: rootSecret,
		reservedHostnames: [],
		fetch: receiver,
		now: () => clock,
		transferMilestones: false
	});

// Runs every application that is due now, so a test starts from a known claim queue.
async function drain(): Promise<void> {
	for (let round = 0; round < 10; round += 1) if ((await job()).claimed === 0) return;
	throw new Error('Due applications kept coming');
}

async function setTotal(tenantId: string, linkId: string, clicks: number): Promise<void> {
	await shard()
		.prepare(
			`INSERT INTO link_click_totals (tenant_id, link_id, clicks, last_event_id, updated_at) VALUES (?, ?, ?, 'event-1', 0)
			ON CONFLICT(tenant_id, link_id) DO UPDATE SET clicks = excluded.clicks`
		)
		.bind(tenantId, linkId, clicks)
		.run();
}

async function addMilestone(tenantId: string, linkId: string, clicks: number): Promise<void> {
	await shard()
		.prepare(
			'INSERT INTO click_milestones (id, tenant_id, link_id, clicks, created_at) VALUES (?, ?, ?, ?, ?)'
		)
		.bind(`link.click_milestone:${linkId}:${clicks}`, tenantId, linkId, clicks, clock)
		.run();
}

async function addEndpoint(
	userId: string,
	events: string[] = ['link.updated', 'link.disabled']
): Promise<CreatedWebhookEndpoint> {
	const created = await call(userId, 'POST', '/webhooks', { url: hookUrl, events });
	expect(created.status, created.text).toBe(201);
	return created.json as CreatedWebhookEndpoint;
}

interface Envelope {
	id: string;
	type: string;
	workspace: { id: string };
	data: Record<string, unknown>;
}

function bodiesOf(tenantId: string): Envelope[] {
	return received
		.map((request) => JSON.parse(request.body) as Envelope)
		.filter((body) => body.workspace.id === tenantId);
}

function base64Bytes(value: string): Uint8Array<ArrayBuffer> {
	return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

// A receiver's check, written from the Standard Webhooks rules and not from the signer.
async function verifies(secret: string, request: Received): Promise<boolean> {
	const entry = (request.headers.get('webhook-signature') ?? '').split(' ')[0] ?? '';
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

// The shard, with hook run just before the read of link click totals.
function beforeTotalsRead(db: D1Database, hook: () => Promise<unknown>): D1Database {
	const passThrough = <T extends object>(target: T, property: string | symbol) => {
		const value: unknown = Reflect.get(target, property, target);
		return typeof value === 'function' ? value.bind(target) : value;
	};
	return new Proxy(db, {
		get(target, property) {
			if (property !== 'prepare') return passThrough(target, property);
			return (query: string) => {
				const statement = target.prepare(query);
				if (!query.includes('link_click_totals')) return statement;
				return new Proxy(statement, {
					get(unbound, name) {
						if (name !== 'bind') return passThrough(unbound, name);
						return (...values: unknown[]) => {
							const bound = unbound.bind(...values);
							return new Proxy(bound, {
								get(ready, method) {
									if (method !== 'all') return passThrough(ready, method);
									return async () => {
										await hook();
										return ready.all();
									};
								}
							});
						};
					}
				});
			};
		}
	});
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

describe('automation routes', () => {
	it('answer 404 without automation settings, before any scope check, and 405 to other methods', async () => {
		await addTenant('u-off', 't-off');
		const off = api({ automations: null });
		const routes = [
			['GET', '/automations'],
			['POST', '/automations'],
			['PATCH', '/automations/aut_x'],
			['DELETE', '/automations/aut_x'],
			['GET', '/automations/aut_x/runs'],
			['POST', '/automations/aut_x/links'],
			['GET', '/links/lnk_x/automations'],
			['PUT', '/links/lnk_x/automations/aut_x'],
			['DELETE', '/links/lnk_x/automations/aut_x']
		] as const;
		for (const [method, path] of routes) {
			const body = method === 'GET' || method === 'DELETE' ? undefined : {};
			const result = await call('u-off', method, path, body, off, {
				'x-test-scopes': 'usage:read'
			});
			expect([result.status, codeOf(result)], `${method} ${path}`).toEqual([404, 'NOT_FOUND']);
		}
		const wrong = await call('u-off', 'GET', '/links/lnk_x/automations/aut_x');
		expect([wrong.status, wrong.headers.get('allow')]).toEqual([405, 'PUT, DELETE']);
		expect((await call('u-off', 'PUT', '/automations')).headers.get('allow')).toBe('GET, POST');
	});

	it('offer the actions and triggers of the installation and refuse the others', async () => {
		await addTenant('u-offer', 't-offer');
		const page = (await call('u-offer', 'GET', '/automations')).json as AutomationPage;
		expect(page).toEqual({
			automations: [],
			used: 0,
			limit: 25,
			actionTypes: ['change_destination', 'disable_link', 'send_webhook', 'email_owner'],
			triggerTypes: ['end_date', 'link_age', 'clicks'],
			perLinkLimit: 5
		});
		const checks = await call('u-offer', 'POST', '/automations', {
			name: 'Down',
			trigger: { type: 'destination_down' },
			actions: [{ type: 'disable_link' }]
		});
		expect([checks.status, codeOf(checks)]).toEqual([422, 'INVALID_INPUT']);
		const noEmail = api({ automations: { email: false, destinationChecks: false } });
		const emailed = await call(
			'u-offer',
			'POST',
			'/automations',
			{ name: 'Mail', ...disable, actions: [{ type: 'email_owner' }] },
			noEmail
		);
		expect([emailed.status, codeOf(emailed)]).toEqual([422, 'INVALID_INPUT']);
		expect(
			((await call('u-offer', 'GET', '/automations', undefined, noEmail)).json as AutomationPage)
				.actionTypes
		).not.toContain('email_owner');
		const missing = await call('u-offer', 'POST', '/automations', {
			name: 'Hook',
			...disable,
			actions: [{ type: 'send_webhook', endpointId: 'whk_none' }]
		});
		expect(missing.json).toMatchObject({ error: { code: 'INVALID_INPUT', field: 'endpointId' } });
	});

	it('never reach another workspace’s templates, links, or runs', async () => {
		await addTenant('u-one', 't-one');
		await addTenant('u-two', 't-two');
		const mine = await template('u-one', { name: 'Mine', ...disable });
		const theirs = await template('u-two', {
			name: 'Theirs',
			trigger: { type: 'end_date' },
			actions: [{ type: 'change_destination', destination: 'https://example.com/theirs' }]
		});
		const myLink = await addLink('t-one');
		const theirLink = await addLink('t-two');
		// The other workspace's template is on its link, so only the refusal stops a removal.
		expect((await put('u-two', theirLink, theirs.id, { endsAt: past() })).status).toBe(200);
		const refused = [
			['PATCH', `/automations/${theirs.id}`, { name: 'Taken' }],
			['DELETE', `/automations/${theirs.id}`, undefined],
			['GET', `/automations/${theirs.id}/runs`, undefined],
			['POST', `/automations/${theirs.id}/links`, { linkIds: [myLink], endsAt: past() }],
			['GET', `/links/${theirLink}/automations`, undefined],
			['PUT', `/links/${theirLink}/automations/${mine.id}`, { endsAt: past() }],
			['PUT', `/links/${myLink}/automations/${theirs.id}`, { endsAt: past() }],
			['DELETE', `/links/${theirLink}/automations/${theirs.id}`, undefined]
		] as const;
		for (const [method, path, body] of refused) {
			const result = await call('u-one', method, path, body);
			expect([result.status, codeOf(result)], `${method} ${path}`).toEqual([404, 'NOT_FOUND']);
		}
		const page = (await call('u-one', 'GET', '/automations')).json as AutomationPage;
		expect(page.automations.map((automation) => automation.id)).toEqual([mine.id]);
		// A mixed bulk apply fails only the other workspace's link.
		const bulk = await call('u-one', 'POST', `/automations/${mine.id}/links`, {
			linkIds: [myLink, theirLink],
			endsAt: past()
		});
		expect((bulk.json as ApplyAutomationLinksResult).results).toEqual([
			{ linkId: myLink, status: 'applied' },
			{
				linkId: theirLink,
				status: 'failed',
				error: { code: 'NOT_FOUND', message: 'Link not found.' }
			}
		]);
		// Each run changes its own workspace's link only.
		await drain();
		expect(await apiLink('t-one', myLink)).toMatchObject({
			enabled: false,
			destination: expect.stringContaining('https://example.com/start/')
		});
		expect(await apiLink('t-two', theirLink)).toMatchObject({
			enabled: true,
			destination: 'https://example.com/theirs'
		});
		expect((await runRecords(mine.id)).map((run) => [run.tenant_id, run.link_id])).toEqual([
			['t-one', myLink]
		]);
		expect((await runRecords(theirs.id)).map((run) => [run.tenant_id, run.link_id])).toEqual([
			['t-two', theirLink]
		]);
	});

	it('let members apply and remove, and only the owner manage templates in the dashboard', async () => {
		await addTenant('u-boss', 't-boss');
		await addMember('u-crew', 't-boss');
		const automation = await template('u-boss', { name: 'Roles', ...disable });
		const linkId = await addLink('t-boss');
		const applyPath = `/links/${linkId}/automations/${automation.id}`;
		expect((await call('u-crew', 'GET', '/automations')).status).toBe(200);
		expect((await put('u-crew', linkId, automation.id, { endsAt: future() })).status).toBe(200);
		expect((await call('u-crew', 'GET', `/links/${linkId}/automations`)).status).toBe(200);
		const bulk = await call('u-crew', 'POST', `/automations/${automation.id}/links`, {
			linkIds: [linkId],
			endsAt: future()
		});
		expect(bulk.status).toBe(200);
		expect((await call('u-crew', 'GET', `/automations/${automation.id}/runs`)).status).toBe(200);
		expect((await call('u-crew', 'DELETE', applyPath)).status).toBe(204);
		const ownerRoutes = [
			['POST', '/automations', { name: 'Mine now', ...disable }],
			['PATCH', `/automations/${automation.id}`, { name: 'Renamed' }],
			['DELETE', `/automations/${automation.id}`, undefined]
		] as const;
		for (const [method, path, body] of ownerRoutes) {
			const result = await call('u-crew', method, path, body);
			expect([result.status, codeOf(result)], `${method} ${path}`).toEqual([403, 'OWNER_REQUIRED']);
		}
		// A member's token applies and removes.
		const writer = { 'x-test-scopes': 'links:read,links:write' };
		const viaToken = await put(
			'u-crew',
			linkId,
			automation.id,
			{ endsAt: future() },
			api(),
			writer
		);
		expect(viaToken.status).toBe(200);
		expect((await call('u-crew', 'DELETE', applyPath, undefined, api(), writer)).status).toBe(204);
		// Tokens and connected apps never manage templates or read runs, even the owner's.
		const sessionRoutes = [
			...ownerRoutes,
			['GET', `/automations/${automation.id}/runs`, undefined]
		] as const;
		for (const credential of [writer, { 'x-test-oauth': '1' }])
			for (const [method, path, body] of sessionRoutes) {
				const result = await call('u-boss', method, path, body, api(), credential);
				expect([result.status, codeOf(result)], `${method} ${path}`).toEqual([
					403,
					'INSUFFICIENT_SCOPE'
				]);
			}
		// links:read lists but cannot apply or remove.
		const reader = { 'x-test-scopes': 'links:read' };
		expect((await call('u-boss', 'GET', '/automations', undefined, api(), reader)).status).toBe(
			200
		);
		const writes = [
			['PUT', applyPath, { endsAt: future() }],
			['DELETE', applyPath, undefined],
			['POST', `/automations/${automation.id}/links`, { linkIds: [linkId], endsAt: future() }]
		] as const;
		for (const [method, path, body] of writes) {
			const result = await call('u-boss', method, path, body, api(), reader);
			expect([result.status, codeOf(result)], `${method} ${path}`).toEqual([
				403,
				'INSUFFICIENT_SCOPE'
			]);
		}
	});

	it('keep the template limit and the per-link cap under concurrent requests', async () => {
		await addTenant('u-race', 't-race', 2);
		const creates = await Promise.all(
			Array.from({ length: 5 }, (_, index) =>
				call('u-race', 'POST', '/automations', { name: `Race ${index}`, ...disable })
			)
		);
		expect(creates.filter((result) => result.status === 201)).toHaveLength(2);
		const full = creates.filter((result) => codeOf(result) === 'AUTOMATION_LIMIT_REACHED');
		expect(full).toHaveLength(3);
		expect(messageOf(full[0])).toBe(
			'This workspace has room for 2 automations. Delete an automation first.'
		);

		await addTenant('u-cap', 't-cap', 10);
		const templates: Automation[] = [];
		for (let index = 0; index < 6; index += 1)
			templates.push(await template('u-cap', { name: `Cap ${index}`, ...disable }));
		const linkId = await addLink('t-cap');
		const applies = await Promise.all(
			templates.map((automation) => put('u-cap', linkId, automation.id, { endsAt: future() }))
		);
		expect(applies.filter((result) => result.status === 200)).toHaveLength(5);
		const capped = applies.findIndex(
			(result) => codeOf(result) === 'LINK_AUTOMATION_LIMIT_REACHED'
		);
		expect(capped).toBeGreaterThanOrEqual(0);
		expect(applies[capped].status).toBe(403);
		expect(
			await routing()
				.prepare('SELECT COUNT(*) AS n FROM link_automations WHERE link_id = ?')
				.bind(linkId)
				.first('n')
		).toBe(5);
		const bulk = await call('u-cap', 'POST', `/automations/${templates[capped].id}/links`, {
			linkIds: [linkId],
			endsAt: future()
		});
		expect((bulk.json as ApplyAutomationLinksResult).results).toMatchObject([
			{ linkId, status: 'failed', error: { code: 'LINK_AUTOMATION_LIMIT_REACHED' } }
		]);
		// A template already on the link still applies at the cap.
		const present = templates[capped === 0 ? 1 : 0];
		expect((await put('u-cap', linkId, present.id, { endsAt: future() })).status).toBe(200);
	});
});

describe('runs', () => {
	it('run an application once, re-arm it on a new apply, and leave a waiting one as it is', async () => {
		await addTenant('u-once', 't-once');
		const automation = await template('u-once', {
			name: 'Once',
			trigger: { type: 'end_date' },
			actions: [{ type: 'change_destination', destination: 'https://example.com/after' }]
		});
		const linkId = await addLink('t-once');
		const endsAt = past();
		const first = await put('u-once', linkId, automation.id, { endsAt });
		expect(first.json).toMatchObject({
			linkId,
			status: 'applied',
			automations: [
				{
					automationId: automation.id,
					name: 'Once',
					state: 'waiting',
					endsAt,
					dueAt: endsAt,
					firedAt: null,
					result: null,
					check: null
				}
			]
		});
		const armedAt = (await application(linkId, automation.id))?.armed_at;
		clock += minute;
		const same = await put('u-once', linkId, automation.id, { endsAt });
		expect((same.json as ApplyLinkAutomationResult).status).toBe('unchanged');
		expect((await application(linkId, automation.id))?.armed_at).toBe(armedAt);
		// A body without a content type is refused; no body at all is no end date.
		const raw = await api().fetch(
			new Request(`${origin}/v1/links/${linkId}/automations/${automation.id}`, {
				method: 'PUT',
				headers: { 'x-test-user': 'u-once', origin },
				body: 'endsAt'
			})
		);
		expect(raw.status).toBe(415);
		const undated = await put('u-once', linkId, automation.id);
		expect(undated.json).toMatchObject({ error: { code: 'INVALID_INPUT', field: 'endsAt' } });

		await drain();
		expect(await application(linkId, automation.id)).toMatchObject({
			state: 'done',
			result_code: null
		});
		expect((await apiLink('t-once', linkId)).destination).toBe('https://example.com/after');
		clock += minute;
		await job();
		expect(await runRecords(automation.id)).toHaveLength(1);
		// Applying again re-arms it, also with the same end date.
		const again = await put('u-once', linkId, automation.id, { endsAt });
		expect(again.json).toMatchObject({
			status: 'applied',
			automations: [{ state: 'waiting', firedAt: null }]
		});
		await job();
		expect((await runRecords(automation.id)).map((run) => run.state)).toEqual([
			'succeeded',
			'succeeded'
		]);
		const listed = await call('u-once', 'GET', `/links/${linkId}/automations`);
		expect((listed.json as LinkAutomationPage).automations).toMatchObject([
			{ state: 'done', firedAt: new Date(clock).toISOString() }
		]);
	});

	it('give concurrent claims different applications, and skip a run whose claim a re-apply cleared', async () => {
		await addTenant('u-claim', 't-claim');
		await drain();
		const automation = await template('u-claim', {
			name: 'Claimed',
			trigger: { type: 'end_date' },
			actions: [{ type: 'change_destination', destination: 'https://example.com/claimed' }]
		});
		const links: string[] = [];
		for (let index = 0; index < 4; index += 1) links.push(await addLink('t-claim'));
		await call('u-claim', 'POST', `/automations/${automation.id}/links`, {
			linkIds: links,
			endsAt: past()
		});
		const [first, second] = await Promise.all([
			claimAutomations(routing(), { token: 'claim-a', now: clock, limit: 2 }),
			claimAutomations(routing(), { token: 'claim-b', now: clock, limit: 10 })
		]);
		const claimed = [...first.claimed, ...second.claimed].map((item) => item.linkId);
		expect(claimed.sort()).toEqual([...links].sort());
		// A re-apply clears the claim, so the claimed run leaves that link alone.
		const cleared = first.claimed[0].linkId;
		const rearmed = await put('u-claim', cleared, automation.id, { endsAt: future() });
		expect((rearmed.json as ApplyLinkAutomationResult).status).toBe('applied');
		const items = (list: typeof first.claimed) =>
			list.map(({ linkId, automationId }) => ({
				linkId,
				automationId,
				linkEventId: `evt_${linkId}_link`,
				triggerEventId: `evt_${linkId}_trigger`,
				messageEventId: `evt_${linkId}_message`,
				runId: `run_${linkId}`
			}));
		const ran = await runAutomations(routing(), {
			token: 'claim-a',
			now: clock,
			items: items(first.claimed)
		});
		expect(ran.ran).toBe(first.claimed.length - 1);
		expect((await apiLink('t-claim', cleared)).destination).not.toBe('https://example.com/claimed');
		expect(await application(cleared, automation.id)).toMatchObject({
			state: 'waiting',
			claim_token: null
		});
		await runAutomations(routing(), { token: 'claim-b', now: clock, items: items(second.claimed) });
		expect((await runRecords(automation.id)).map((run) => run.state)).toEqual(
			Array(3).fill('succeeded')
		);
	});

	it('run one application per link in each run', async () => {
		await addTenant('u-pair', 't-pair');
		await drain();
		const make = (name: string) =>
			template('u-pair', {
				name,
				trigger: { type: 'end_date' },
				actions: [{ type: 'change_destination', destination: `https://example.com/${name}` }]
			});
		const early = await make('early');
		const late = await make('late');
		const linkId = await addLink('t-pair');
		await put('u-pair', linkId, early.id, { endsAt: new Date(clock - 2 * minute).toISOString() });
		await put('u-pair', linkId, late.id, { endsAt: past() });
		expect((await job()).claimed).toBe(1);
		expect((await apiLink('t-pair', linkId)).destination).toBe('https://example.com/early');
		expect((await job()).claimed).toBe(1);
		expect((await apiLink('t-pair', linkId)).destination).toBe('https://example.com/late');
	});

	it('run conditions already met at apply time in the next run, and a click total that reaches N', async () => {
		await addTenant('u-met', 't-met');
		const dated = await template('u-met', { name: 'Date', ...disable });
		const aged = await template('u-met', {
			name: 'Age',
			trigger: { type: 'link_age', days: 5 },
			actions: [{ type: 'disable_link' }]
		});
		const counted = await template('u-met', {
			name: 'Clicks',
			trigger: { type: 'clicks', clicks: 1000 },
			actions: [{ type: 'disable_link' }]
		});
		const dateLink = await addLink('t-met');
		const oldLink = await addLink('t-met', clock - 10 * day);
		const busyLink = await addLink('t-met');
		await setTotal('t-met', busyLink, 1200);
		await put('u-met', dateLink, dated.id, { endsAt: past() });
		const age = await put('u-met', oldLink, aged.id);
		expect((age.json as ApplyLinkAutomationResult).automations[0].dueAt).toBe(
			new Date(clock - 5 * day).toISOString()
		);
		const clicks = await put('u-met', busyLink, counted.id);
		expect((clicks.json as ApplyLinkAutomationResult).automations[0].dueAt).toBe(
			new Date(clock).toISOString()
		);
		await job();
		for (const [linkId, automationId] of [
			[dateLink, dated.id],
			[oldLink, aged.id],
			[busyLink, counted.id]
		]) {
			expect(await application(linkId, automationId)).toMatchObject({ state: 'done' });
			expect((await apiLink('t-met', linkId)).enabled).toBe(false);
		}
		// 900 counted clicks at apply time, then the 1000th arrives as a milestone.
		const growing = await addLink('t-met');
		await setTotal('t-met', growing, 900);
		const waiting = await put('u-met', growing, counted.id);
		expect((waiting.json as ApplyLinkAutomationResult).automations[0].dueAt).toBeNull();
		expect(await application(growing, counted.id)).toMatchObject({ reached_clicks: 900 });
		await addMilestone('t-met', growing, 1000);
		clock += minute;
		const run = await job();
		expect(run.milestones).toBe(0);
		expect(await application(growing, counted.id)).toMatchObject({
			state: 'done',
			reached_clicks: 1000
		});
	});

	it('make a clicks application due when a milestone moves between the apply and the read, or after a failed read', async () => {
		await addTenant('u-gap', 't-gap');
		const counted = await template('u-gap', {
			name: 'Thousand',
			trigger: { type: 'clicks', clicks: 1000 },
			actions: [{ type: 'disable_link' }]
		});
		const moved = await addLink('t-gap');
		await setTotal('t-gap', moved, 1000);
		await addMilestone('t-gap', moved, 1000);
		// The job moves the milestone after the insert and before the total is read.
		const hooked = beforeTotalsRead(shard(), () => transferClickMilestones(policyStores(), clock));
		const applied = await put(
			'u-gap',
			moved,
			counted.id,
			undefined,
			api({ analytics: { 'analytics-1': hooked } })
		);
		expect(applied.status).toBe(200);
		expect(
			await shard()
				.prepare('SELECT COUNT(*) AS n FROM click_milestones WHERE link_id = ?')
				.bind(moved)
				.first('n')
		).toBe(0);
		expect(await application(moved, counted.id)).toMatchObject({
			reached_clicks: 1000,
			due_at: clock
		});

		// A read that fails leaves the apply in place; the next milestone makes it due.
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
		const broken = new Proxy(shard(), {
			get(target, property) {
				if (property === 'prepare')
					return () => {
						throw new Error('Shard unavailable');
					};
				const value: unknown = Reflect.get(target, property, target);
				return typeof value === 'function' ? value.bind(target) : value;
			}
		});
		const failing = await addLink('t-gap');
		await setTotal('t-gap', failing, 1000);
		const unread = await put(
			'u-gap',
			failing,
			counted.id,
			undefined,
			api({ analytics: { 'analytics-1': broken } })
		);
		expect(unread.status).toBe(200);
		expect(await application(failing, counted.id)).toMatchObject({
			state: 'waiting',
			due_at: null,
			reached_clicks: null
		});
		const logged = errors.mock.calls.map((args) => String(args[0]));
		expect(logged).toContain(
			JSON.stringify({ event: 'automation_click_totals_failed', automationId: counted.id })
		);
		expect(logged.join('\n')).not.toContain('https://');
		errors.mockRestore();
		await addMilestone('t-gap', failing, 1000);
		await job();
		expect(await application(moved, counted.id)).toMatchObject({ state: 'done' });
		expect(await application(failing, counted.id)).toMatchObject({ state: 'done' });
	});

	it('mark clicks applications from milestones once, and recompute them when the threshold changes', async () => {
		await addTenant('u-marks', 't-marks');
		const counted = await template('u-marks', {
			name: 'Marks',
			trigger: { type: 'clicks', clicks: 1000 },
			actions: [{ type: 'disable_link' }]
		});
		const linkId = await addLink('t-marks');
		await put('u-marks', linkId, counted.id);
		const at = (clicks: number): ClickMilestone => ({
			id: `link.click_milestone:${linkId}:${clicks}`,
			tenantId: 't-marks',
			linkId,
			clicks,
			createdAt: clock
		});
		const mark = (milestones: ClickMilestone[], now: number) =>
			routing().batch([
				milestoneEventsStatement(routing(), milestones),
				markClickApplications(routing(), milestones, now)
			]);
		await mark([at(500)], clock);
		expect(await application(linkId, counted.id)).toMatchObject({
			reached_clicks: 500,
			due_at: null
		});
		const lower = await call('u-marks', 'PATCH', `/automations/${counted.id}`, {
			trigger: { type: 'clicks', clicks: 500 }
		});
		expect((lower.json as { automation: Automation }).automation.trigger).toEqual({
			type: 'clicks',
			clicks: 500
		});
		expect((await application(linkId, counted.id))?.due_at).toBe(clock);
		await call('u-marks', 'PATCH', `/automations/${counted.id}`, {
			trigger: { type: 'clicks', clicks: 2000 }
		});
		expect((await application(linkId, counted.id))?.due_at).toBeNull();
		await mark([at(1000), at(2000)], clock + minute);
		expect(await application(linkId, counted.id)).toMatchObject({
			reached_clicks: 2000,
			due_at: clock + minute
		});
		// A repeat before the shard deletes the milestones changes nothing.
		await mark([at(1000), at(2000)], clock + 2 * minute);
		expect(await application(linkId, counted.id)).toMatchObject({
			state: 'waiting',
			reached_clicks: 2000,
			due_at: clock + minute
		});
		expect(
			(await call('u-marks', 'DELETE', `/links/${linkId}/automations/${counted.id}`)).status
		).toBe(204);
	});

	it('recompute waiting link-age applications when the days change, and leave finished ones', async () => {
		await addTenant('u-days', 't-days');
		const aged = await template('u-days', {
			name: 'Days',
			trigger: { type: 'link_age', days: 30 },
			actions: [{ type: 'disable_link' }]
		});
		const waiting = await addLink('t-days', clock - 10 * day);
		const finished = await addLink('t-days', clock - 40 * day);
		await call('u-days', 'POST', `/automations/${aged.id}/links`, {
			linkIds: [waiting, finished]
		});
		await job();
		expect(await application(waiting, aged.id)).toMatchObject({
			state: 'waiting',
			due_at: clock + 20 * day
		});
		const before = await application(finished, aged.id);
		expect(before?.state).toBe('done');
		clock += minute;
		const edited = await call('u-days', 'PATCH', `/automations/${aged.id}`, {
			trigger: { type: 'link_age', days: 60 }
		});
		expect(edited.status).toBe(200);
		expect((await application(waiting, aged.id))?.due_at).toBe(start + 50 * day);
		expect(await application(finished, aged.id)).toEqual(before);
		const retyped = await call('u-days', 'PATCH', `/automations/${aged.id}`, {
			trigger: { type: 'end_date' }
		});
		expect(retyped.json).toMatchObject({ error: { code: 'INVALID_INPUT', field: 'trigger' } });
	});
});

describe('actions', () => {
	it('change the link, stage its subscriber event, and send one signed automation event, in order', async () => {
		await addTenant('u-act', 't-act');
		const { endpoint, secret } = await addEndpoint('u-act');
		const automation = await template('u-act', {
			name: 'Spring sale ends',
			trigger: { type: 'end_date' },
			actions: [
				{ type: 'email_owner' },
				{ type: 'send_webhook', endpointId: endpoint.id },
				{ type: 'disable_link' },
				{ type: 'change_destination', destination: 'https://example.com/sold-out' }
			]
		});
		expect(automation.actions.map((action) => action.type)).toEqual([
			'change_destination',
			'disable_link',
			'send_webhook',
			'email_owner'
		]);
		const linkId = await addLink('t-act');
		const before = await apiLink('t-act', linkId);
		const endsAt = past();
		await put('u-act', linkId, automation.id, { endsAt });
		await job();
		const after = await apiLink('t-act', linkId);
		expect(after).toMatchObject({ destination: 'https://example.com/sold-out', enabled: false });
		await webhookJob();
		const bodies = bodiesOf('t-act');
		expect(bodies.map((body) => body.type).sort()).toEqual([
			'automation.triggered',
			'link.disabled'
		]);
		const disabled = bodies.find((body) => body.type === 'link.disabled');
		expect(disabled?.data).toEqual({
			link: after,
			previous: {
				destination: before.destination,
				title: null,
				iosDestination: null,
				androidDestination: null,
				enabled: true
			}
		});
		const triggered = bodies.find((body) => body.type === 'automation.triggered');
		expect(triggered?.data).toEqual({
			automation: {
				id: automation.id,
				name: 'Spring sale ends',
				trigger: { type: 'end_date', endsAt }
			},
			link: after,
			actions: ['change_destination', 'disable_link', 'send_webhook', 'email_owner']
		});
		for (const request of received) expect(await verifies(secret, request)).toBe(true);
		const runs = (await call('u-act', 'GET', `/automations/${automation.id}/runs`))
			.json as AutomationRunPage;
		expect(runs.runs).toMatchObject([
			{
				linkId,
				shortUrl: after.shortUrl,
				state: 'succeeded',
				result: null,
				actions: ['change_destination', 'disable_link', 'send_webhook', 'email_owner']
			}
		]);
	});

	it('retry an automation event that the receiver refuses, with the same ID', async () => {
		await addTenant('u-retry', 't-retry');
		const { endpoint } = await addEndpoint('u-retry', ['link.enabled']);
		const automation = await template('u-retry', {
			name: 'Notify',
			trigger: { type: 'end_date' },
			actions: [{ type: 'send_webhook', endpointId: endpoint.id }]
		});
		const linkId = await addLink('t-retry');
		await put('u-retry', linkId, automation.id, { endsAt: past() });
		await job();
		answer = () => new Response(null, { status: 500 });
		await webhookJob();
		const first = received.filter(
			(request) => (JSON.parse(request.body) as Envelope).type === 'automation.triggered'
		);
		expect(first).toHaveLength(1);
		answer = () => new Response(null, { status: 204 });
		clock += 10 * minute;
		await webhookJob();
		const all = received.filter(
			(request) => (JSON.parse(request.body) as Envelope).type === 'automation.triggered'
		);
		expect(all).toHaveLength(2);
		expect(all[1].headers.get('webhook-id')).toBe(first[0].headers.get('webhook-id'));
		const history = await call('u-retry', 'GET', `/webhooks/${endpoint.id}/deliveries`);
		expect((history.json as { deliveries: WebhookDelivery[] }).deliveries).toMatchObject([
			{ eventType: 'automation.triggered', state: 'succeeded', attempts: 2 }
		]);
	});

	it('record one email notice per template and run, with counts, and the short URL of one link', async () => {
		await addTenant('u-mail', 't-mail');
		await addEndpoint('u-mail', ['link.updated']);
		const moved = await template('u-mail', {
			name: 'Move',
			trigger: { type: 'end_date' },
			actions: [
				{ type: 'change_destination', destination: 'https://example.com/moved' },
				{ type: 'email_owner' }
			]
		});
		const single = await template('u-mail', {
			name: 'Single',
			...disable,
			actions: [{ type: 'disable_link' }, { type: 'email_owner' }]
		});
		const quiet = await template('u-mail', { name: 'Quiet', ...disable });
		const [first, second, third, fourth] = [
			await addLink('t-mail'),
			await addLink('t-mail'),
			await addLink('t-mail'),
			await addLink('t-mail')
		];
		await call('u-mail', 'POST', `/automations/${moved.id}/links`, {
			linkIds: [first, second],
			endsAt: past()
		});
		await put('u-mail', third, single.id, { endsAt: past() });
		await put('u-mail', fourth, quiet.id, { endsAt: past() });
		await job();
		const { results } = await identity()
			.prepare(
				"SELECT kind, dedupe_key, params FROM notices WHERE tenant_id = 't-mail' ORDER BY json_extract(params, '$.automationName')"
			)
			.all<{ kind: string; dedupe_key: string; params: string }>();
		const thirdLink = await apiLink('t-mail', third);
		expect(results.map((row) => [row.kind, JSON.parse(row.params)])).toEqual([
			['automation_ran', { automationId: moved.id, automationName: 'Move', links: 2, failed: 0 }],
			[
				'automation_ran',
				{
					automationId: single.id,
					automationName: 'Single',
					links: 1,
					failed: 0,
					shortUrl: thirdLink.shortUrl
				}
			]
		]);
		expect(results[0].dedupe_key.startsWith(`automation_ran:${moved.id}:`)).toBe(true);
		// The dispatcher's render chain turns them into emails.
		const claimed = (await claimNotices(identity(), clock, 100)).filter(
			(notice) => notice.tenantId === 't-mail'
		);
		const emails = claimed.map((notice) =>
			automationNoticeEmail(notice, 'owner@example.com', 'https://app.example/app')
		);
		expect(emails.map((email) => email?.subject).sort()).toEqual([
			'Automation "Move" ran on 2 links in workspace "Workspace"',
			'Automation "Single" ran on 1 link in workspace "Workspace"'
		]);
		const one = emails.find((email) => email?.subject.includes('Single'));
		expect(one?.text).toContain(thirdLink.shortUrl);
		expect(one?.text).toContain('https://app.example/app/automations');
		expect(one?.html).toContain('<a href="https://app.example/app/automations">');
		expect(automationNoticeEmail({ ...claimed[0], kind: 'usage' }, 'o@example.com', '')).toBeNull();
		expect(
			automationNoticeEmail(
				{ ...claimed[0], params: { automationName: 'Bad', links: 0, failed: 0 } },
				'o@example.com',
				''
			)
		).toBeNull();
		// A destination change reaches the link.updated subscriber with the link as the API shows it.
		await webhookJob();
		const updated = bodiesOf('t-mail').filter((body) => body.type === 'link.updated');
		expect(
			updated
				.map((body) => body.data.link)
				.sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1))
		).toEqual(
			[await apiLink('t-mail', first), await apiLink('t-mail', second)].sort((a, b) =>
				JSON.stringify(a) < JSON.stringify(b) ? -1 : 1
			)
		);
		// An installation without email records none.
		const fifth = await addLink('t-mail');
		await put('u-mail', fifth, single.id, { endsAt: past() });
		clock += minute;
		await job({ email: false });
		expect(await application(fifth, single.id)).toMatchObject({ state: 'done' });
		expect(
			await identity()
				.prepare("SELECT COUNT(*) AS n FROM notices WHERE tenant_id = 't-mail'")
				.first('n')
		).toBe(2);
	});

	it('record one email notice per template when a job run takes several claim rounds', async () => {
		await addTenant('u-rounds', 't-rounds');
		const rounds = await template('u-rounds', {
			name: 'Rounds',
			...disable,
			actions: [{ type: 'disable_link' }, { type: 'email_owner' }]
		});
		const links: string[] = [];
		for (let index = 0; index < 101; index += 1) links.push(await addLink('t-rounds'));
		for (const linkIds of [links.slice(0, 100), links.slice(100)])
			await call('u-rounds', 'POST', `/automations/${rounds.id}/links`, {
				linkIds,
				endsAt: past()
			});
		expect(await job({ maxApplications: 101 })).toMatchObject({
			claimed: 101,
			ran: 101,
			notices: 1
		});
		const { results } = await identity()
			.prepare("SELECT params FROM notices WHERE tenant_id = 't-rounds'")
			.all<{ params: string }>();
		expect(results.map((row) => JSON.parse(row.params))).toEqual([
			{ automationId: rounds.id, automationName: 'Rounds', links: 101, failed: 0 }
		]);
	});

	it('skip a turned-off endpoint, and record a deleted one or webhooks off while the link actions run', async () => {
		await addTenant('u-ends', 't-ends');
		const { endpoint } = await addEndpoint('u-ends', ['link.enabled']);
		const notify = await template('u-ends', {
			name: 'Notify',
			trigger: { type: 'end_date' },
			actions: [{ type: 'disable_link' }, { type: 'send_webhook', endpointId: endpoint.id }]
		});
		await call('u-ends', 'PATCH', `/webhooks/${endpoint.id}`, { enabled: false });
		const offLink = await addLink('t-ends');
		await put('u-ends', offLink, notify.id, { endsAt: past() });
		await job();
		await webhookJob();
		expect(bodiesOf('t-ends')).toEqual([]);
		expect(await application(offLink, notify.id)).toMatchObject({ state: 'done' });
		const test = await call('u-ends', 'POST', `/webhooks/${endpoint.id}/test`);
		expect(test.status).toBe(200);
		expect(bodiesOf('t-ends').map((body) => body.type)).toEqual(['webhook.test']);

		expect((await call('u-ends', 'DELETE', `/webhooks/${endpoint.id}`)).status).toBe(204);
		const goneLink = await addLink('t-ends');
		clock += minute;
		await put('u-ends', goneLink, notify.id, { endsAt: past() });
		await job();
		expect(await application(goneLink, notify.id)).toMatchObject({
			state: 'failed',
			result_code: 'endpoint_missing'
		});
		expect((await apiLink('t-ends', goneLink)).enabled).toBe(false);

		const { endpoint: second } = await addEndpoint('u-ends', ['link.enabled']);
		const notifyAgain = await template('u-ends', {
			name: 'Notify again',
			trigger: { type: 'end_date' },
			actions: [{ type: 'disable_link' }, { type: 'send_webhook', endpointId: second.id }]
		});
		await setLimits('t-ends', { webhookEndpointLimit: 0, automationLimit: 25 });
		const planLink = await addLink('t-ends');
		await put('u-ends', planLink, notifyAgain.id, { endsAt: past() });
		await job();
		expect(await application(planLink, notifyAgain.id)).toMatchObject({
			state: 'failed',
			result_code: 'webhooks_off'
		});
		expect((await apiLink('t-ends', planLink)).enabled).toBe(false);
		expect(
			(await runRecords(notify.id)).map((run) => [run.state, run.result_code, run.actions])
		).toEqual([
			['succeeded', null, ['disable_link', 'send_webhook']],
			['failed', 'endpoint_missing', ['disable_link']]
		]);
		expect(
			(await runRecords(notifyAgain.id)).map((run) => [run.state, run.result_code, run.actions])
		).toEqual([['failed', 'webhooks_off', ['disable_link']]]);
	});

	it('refuse a destination change on a blocked link and do nothing else; turning it off works', async () => {
		await addTenant('u-block', 't-block');
		const move = await template('u-block', {
			name: 'Move',
			trigger: { type: 'end_date' },
			actions: [
				{ type: 'change_destination', destination: 'https://example.com/elsewhere' },
				{ type: 'email_owner' }
			]
		});
		const off = await template('u-block', { name: 'Off', ...disable });
		const linkId = await addLink('t-block');
		const before = await apiLink('t-block', linkId);
		await put('u-block', linkId, move.id, { endsAt: new Date(clock - 2 * minute).toISOString() });
		await put('u-block', linkId, off.id, { endsAt: past() });
		await setLinkBlock(routing(), linkId, { reason: 'spam', now: clock });
		await job();
		await job();
		expect(await application(linkId, move.id)).toMatchObject({
			state: 'failed',
			result_code: 'link_blocked'
		});
		expect(await application(linkId, off.id)).toMatchObject({ state: 'done' });
		const after = await readLink(routing(), 't-block', linkId);
		expect(after).toMatchObject({ destination: before.destination, active: false });
		expect((await runRecords(move.id)).map((run) => [run.actions, run.email])).toEqual([[[], 0]]);
		expect(
			await identity()
				.prepare("SELECT COUNT(*) AS n FROM notices WHERE tenant_id = 't-block'")
				.first('n')
		).toBe(0);
		const refused = await put('u-block', linkId, move.id, { endsAt: future() });
		expect([refused.status, codeOf(refused)]).toEqual([409, 'LINK_BLOCKED']);
		const bulk = await call('u-block', 'POST', `/automations/${off.id}/links`, {
			linkIds: [linkId],
			endsAt: future()
		});
		expect((bulk.json as ApplyAutomationLinksResult).results).toMatchObject([
			{ status: 'failed', error: { code: 'LINK_BLOCKED' } }
		]);
	});
});

describe('limits and states', () => {
	it('skip due applications at limit 0 or with the template off, and run new ones after a restore', async () => {
		await addTenant('u-down', 't-down');
		const automation = await template('u-down', { name: 'Down', ...disable });
		const [first, second, third] = [
			await addLink('t-down'),
			await addLink('t-down'),
			await addLink('t-down')
		];
		await put('u-down', first, automation.id, { endsAt: past() });
		await put('u-down', second, automation.id, { endsAt: past() });
		await setLimits('t-down', { automationLimit: 0 });
		const refusals = [
			await call('u-down', 'POST', '/automations', { name: 'More', ...disable }),
			await put('u-down', third, automation.id, { endsAt: past() }),
			await call('u-down', 'POST', `/automations/${automation.id}/links`, {
				linkIds: [third],
				endsAt: past()
			})
		];
		for (const refused of refusals) {
			expect([refused.status, codeOf(refused)]).toEqual([403, 'AUTOMATION_LIMIT_REACHED']);
			expect(messageOf(refused)).toBe('Automations are not available for this workspace.');
		}
		const listed = (await call('u-down', 'GET', '/automations')).json as AutomationPage;
		expect(listed).toMatchObject({ used: 1, limit: 0, automations: [{ id: automation.id }] });
		await job();
		for (const linkId of [first, second])
			expect(await application(linkId, automation.id)).toMatchObject({
				state: 'skipped',
				result_code: 'plan'
			});

		await setLimits('t-down', { automationLimit: 25 });
		await call('u-down', 'PATCH', `/automations/${automation.id}`, { enabled: false });
		clock += minute;
		await put('u-down', third, automation.id, { endsAt: past() });
		await job();
		expect(await application(third, automation.id)).toMatchObject({
			state: 'skipped',
			result_code: 'off'
		});
		await call('u-down', 'PATCH', `/automations/${automation.id}`, { enabled: true });
		clock += minute;
		await put('u-down', first, automation.id, { endsAt: past() });
		await job();
		expect(await application(first, automation.id)).toMatchObject({ state: 'done' });
		expect(await application(second, automation.id)).toMatchObject({
			state: 'skipped',
			result_code: 'plan'
		});
		const records = (await runRecords(automation.id)).map((run) => [
			run.link_id,
			run.state,
			run.result_code
		]);
		// The two plan skips share a time, so their order is open.
		expect(records.slice(0, 2)).toEqual(
			expect.arrayContaining([
				[first, 'skipped', 'plan'],
				[second, 'skipped', 'plan']
			])
		);
		expect(records.slice(2)).toEqual([
			[third, 'skipped', 'off'],
			[first, 'succeeded', null]
		]);
	});

	it('let due applications wait while the workspace is suspended, and run them after reinstatement', async () => {
		await addTenant('u-sus', 't-sus');
		const automation = await template('u-sus', { name: 'Suspended', ...disable });
		const spare = await template('u-sus', { name: 'Spare', ...disable });
		const due = await addLink('t-sus');
		const later = await addLink('t-sus');
		await put('u-sus', due, automation.id, { endsAt: past() });
		await put('u-sus', later, automation.id, { endsAt: future() });
		await suspendTenant(identity(), policyStores(), operator, {
			tenantId: 't-sus',
			reason: 'spam',
			now: clock
		});
		await job();
		expect(await application(due, automation.id)).toMatchObject({ state: 'waiting', attempts: 0 });
		expect(await runRecords(automation.id)).toEqual([]);
		expect((await call('u-sus', 'GET', '/automations')).status).toBe(200);
		const refused = await put('u-sus', later, automation.id, { endsAt: future() });
		expect([refused.status, codeOf(refused)]).toEqual([403, 'WORKSPACE_SUSPENDED']);
		const token = await call(
			'u-sus',
			'DELETE',
			`/links/${later}/automations/${automation.id}`,
			undefined,
			api(),
			{
				'x-test-scopes': 'links:write'
			}
		);
		expect(codeOf(token)).toBe('WORKSPACE_SUSPENDED');
		expect(
			(await call('u-sus', 'DELETE', `/links/${later}/automations/${automation.id}`)).status
		).toBe(204);
		expect((await call('u-sus', 'DELETE', `/automations/${spare.id}`)).status).toBe(204);
		await reinstateTenant(identity(), policyStores(), operator, { tenantId: 't-sus', now: clock });
		await job();
		expect(await application(due, automation.id)).toMatchObject({ state: 'done' });
	});

	it('retry a claim that never ran after its lease, and fail it after 5 claims', async () => {
		await addTenant('u-lost', 't-lost');
		await drain();
		const automation = await template('u-lost', { name: 'Lost', ...disable });
		const linkId = await addLink('t-lost');
		await put('u-lost', linkId, automation.id, { endsAt: past() });
		const lost = await claimAutomations(routing(), { token: 'lost-1', now: clock, limit: 100 });
		expect(lost.claimed.map((item) => item.linkId)).toEqual([linkId]);
		clock += 5 * minute;
		expect((await job()).claimed).toBe(0);
		expect(await application(linkId, automation.id)).toMatchObject({
			state: 'waiting',
			attempts: 1
		});
		clock += 11 * minute;
		await job();
		expect(await application(linkId, automation.id)).toMatchObject({ state: 'done', attempts: 2 });

		const stuck = await addLink('t-lost');
		await put('u-lost', stuck, automation.id, { endsAt: past() });
		for (let attempt = 1; attempt <= 5; attempt += 1) {
			const claim = await claimAutomations(routing(), {
				token: `stuck-${attempt}`,
				now: clock,
				limit: 100
			});
			expect(claim.claimed.map((item) => item.linkId)).toEqual([stuck]);
			clock += 16 * minute;
		}
		const run = await job();
		expect(run).toMatchObject({ claimed: 0, skipped: 1 });
		expect(await application(stuck, automation.id)).toMatchObject({
			state: 'failed',
			result_code: 'attempts',
			attempts: 5
		});
		expect((await runRecords(automation.id)).map((item) => [item.state, item.result_code])).toEqual(
			[
				['succeeded', null],
				['failed', 'attempts']
			]
		);
	});

	it('list a template’s newest 100 runs, and delete runs after 90 days', async () => {
		await addTenant('u-runs', 't-runs');
		const automation = await template('u-runs', { name: 'Runs', ...disable });
		const linkId = await addLink('t-runs');
		const states = ['succeeded', 'failed', 'skipped'] as const;
		const results = [null, 'link_blocked', 'plan'];
		const insert = (index: number, createdAt: number) =>
			routing()
				.prepare(
					`INSERT INTO automation_runs (id, tenant_id, automation_id, automation_name, link_id, claim_token, state, result_code, actions, email, created_at)
					VALUES (?, 't-runs', ?, 'Runs', ?, 'token', ?, ?, ?, 0, ?)`
				)
				.bind(
					`run_list_${String(index).padStart(3, '0')}`,
					automation.id,
					linkId,
					states[index % 3],
					results[index % 3],
					index % 3 === 0 ? '["disable_link"]' : '[]',
					createdAt
				);
		await routing().batch(
			Array.from({ length: 105 }, (_, index) => insert(index, clock - (104 - index) * minute))
		);
		const page = (await call('u-runs', 'GET', `/automations/${automation.id}/runs`))
			.json as AutomationRunPage;
		expect(page.runs).toHaveLength(100);
		expect(page.runs[0]).toEqual({
			id: 'run_list_104',
			linkId,
			shortUrl: (await apiLink('t-runs', linkId)).shortUrl,
			state: 'skipped',
			result: 'plan',
			actions: [],
			createdAt: new Date(clock).toISOString()
		});
		expect(page.runs.at(-1)?.id).toBe('run_list_005');
		expect(new Set(page.runs.map((run) => run.state))).toEqual(new Set(states));

		await routing().batch([insert(900, clock - 91 * day), insert(901, clock - 90 * day - minute)]);
		const counter = { queries: 0 };
		const cleaned = await cleanupAutomations(counting(routing(), counter), clock);
		expect(cleaned.deleted).toBeGreaterThanOrEqual(2);
		expect(counter.queries).toBe(1);
		expect(
			await routing()
				.prepare('SELECT COUNT(*) AS n FROM automation_runs WHERE automation_id = ?')
				.bind(automation.id)
				.first('n')
		).toBe(105);
	});

	it('leave workspace deletion with no template, application, or run, without a cascade past the limit', async () => {
		await addTenant('u-gone', 't-gone');
		const automation = await template('u-gone', { name: 'Gone', ...disable });
		const links: string[] = [];
		for (let index = 0; index < 4; index += 1) links.push(await addLink('t-gone'));
		await call('u-gone', 'POST', `/automations/${automation.id}/links`, {
			linkIds: links.slice(0, 3),
			endsAt: future()
		});
		await put('u-gone', links[3], automation.id, { endsAt: past() });
		await job();
		const counts = async () =>
			routing()
				.prepare(
					`SELECT (SELECT COUNT(*) FROM automations WHERE tenant_id = ?1) AS automations,
						(SELECT COUNT(*) FROM link_automations WHERE tenant_id = ?1) AS applications,
						(SELECT COUNT(*) FROM automation_runs WHERE tenant_id = ?1) AS runs`
				)
				.bind('t-gone')
				.first<{ automations: number; applications: number; runs: number }>();
		expect(await counts()).toEqual({ automations: 1, applications: 4, runs: 1 });
		await deleteRoutingData(routing(), 't-gone', 2);
		// Only 2 applications go; the template keeps the rest, so its cascade removes nothing.
		expect(await counts()).toEqual({ automations: 1, applications: 2, runs: 0 });
		for (let round = 0; round < 10; round += 1)
			if ((await deleteRoutingData(routing(), 't-gone', 2)) === 0) break;
		expect(await counts()).toEqual({ automations: 0, applications: 0, runs: 0 });
	});

	it('heal a routing row projected without the automation limit, and keep a stored one', async () => {
		await addTenant('u-heal', 't-heal', 7);
		const limitIn = () =>
			routing()
				.prepare(
					"SELECT automation_limit AS n, revision FROM tenant_policy WHERE tenant_id = 't-heal'"
				)
				.first<{ n: number | null; revision: number }>();
		await routing()
			.prepare("UPDATE tenant_policy SET automation_limit = NULL WHERE tenant_id = 't-heal'")
			.run();
		// NULL counts as 0 until the heal.
		expect(((await call('u-heal', 'GET', '/automations')).json as AutomationPage).limit).toBe(0);
		const healed = await retryProjections(identity(), policyStores(), clock, 100);
		expect(healed.failed).toBe(0);
		const row = await limitIn();
		expect(row?.n).toBe(7);
		if (!row) throw new Error('Expected the routing policy');
		await applyRoutingPolicy(routing(), {
			tenantId: 't-heal',
			revision: row.revision,
			analyticsShardId: 'analytics-1',
			activeLinkLimit: 100,
			domainLimit: 1,
			webhookEndpointLimit: 5,
			automationLimit: 1,
			linkAccess: 0,
			suspendedAt: null,
			now: clock
		});
		expect((await limitIn())?.n).toBe(7);
	});
});

describe('statement budgets', () => {
	it('apply one link and 100 links within 12 statements, and run the job within its budget', async () => {
		await addTenant('u-budget', 't-budget');
		const { endpoint } = await addEndpoint('u-budget', ['link.updated']);
		const counted = await template('u-budget', {
			name: 'Budget clicks',
			trigger: { type: 'clicks', clicks: 100 },
			actions: [{ type: 'disable_link' }]
		});
		const links: string[] = [];
		for (let index = 0; index < 101; index += 1) links.push(await addLink('t-budget'));
		await setTotal('t-budget', links[0], 150);
		await setTotal('t-budget', links[1], 50);
		const counter = { queries: 0 };
		const measured = api({
			identity: counting(identity(), counter),
			routing: counting(routing(), counter),
			analytics: { 'analytics-1': counting(shard(), counter) }
		});
		const single = await put('u-budget', links[0], counted.id, undefined, measured);
		expect(single.status).toBe(200);
		// Workspace 1, template 1, apply 1, shard 1, totals 1, click record 1, the link's list 1.
		const singleQueries = counter.queries;
		expect(singleQueries).toBe(7);
		counter.queries = 0;
		const bulk = await call(
			'u-budget',
			'POST',
			`/automations/${counted.id}/links`,
			{ linkIds: [...links.slice(1, 100), 'lnk_none'] },
			measured
		);
		expect((bulk.json as ApplyAutomationLinksResult).results).toHaveLength(100);
		// Workspace 1, template 1, apply 1, the reason read 1, shard 1, totals 1, click record 1.
		const bulkQueries = counter.queries;
		expect(bulkQueries).toBe(7);
		for (const queries of [singleQueries, bulkQueries]) expect(queries).toBeLessThan(12);
		expect((await application(links[0], counted.id))?.due_at).toBe(clock);
		expect((await application(links[1], counted.id))?.reached_clicks).toBe(50);
		expect((await call('u-budget', 'DELETE', `/automations/${counted.id}`)).status).toBe(204);

		// The job: idle, then busy with a milestone, a skip, and 25 runs with every action.
		await drain();
		const jobCounter = { queries: 0 };
		const measuredJob = (options: Partial<AutomationJobOptions> = {}) =>
			runAutomationJob(
				{
					identity: counting(identity(), jobCounter),
					routing: counting(routing(), jobCounter),
					analytics: { 'analytics-1': counting(shard(), jobCounter) }
				},
				{ email: true, now: () => clock, ...options }
			);
		await measuredJob();
		// The shard's milestone read and the 2-statement claim.
		expect(jobCounter.queries).toBe(3);
		expect(jobCounter.queries).toBeLessThanOrEqual(4);

		const every = await template('u-budget', {
			name: 'Every action',
			trigger: { type: 'end_date' },
			actions: [
				{ type: 'change_destination', destination: 'https://example.com/every' },
				{ type: 'disable_link' },
				{ type: 'send_webhook', endpointId: endpoint.id },
				{ type: 'email_owner' }
			]
		});
		const off = await template('u-budget', { name: 'Off', ...disable });
		await call('u-budget', 'POST', `/automations/${every.id}/links`, {
			linkIds: links.slice(0, 25),
			endsAt: past()
		});
		await put('u-budget', links[30], off.id, { endsAt: past() });
		await call('u-budget', 'PATCH', `/automations/${off.id}`, { enabled: false });
		await addMilestone('t-budget', links[40], 100);
		jobCounter.queries = 0;
		const busy = await measuredJob();
		expect(busy).toMatchObject({ claimed: 25, ran: 25, skipped: 1, notices: 1 });
		// Transfer 4, claim 2, skipped runs 1, the run batch 8, notices 1.
		expect(jobCounter.queries).toBe(16);
		expect(jobCounter.queries).toBeLessThanOrEqual(18);
	});
});
