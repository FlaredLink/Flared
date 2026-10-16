// SPDX-License-Identifier: AGPL-3.0-only
// POST /v1/links/import against the real API, D1, redirects, and API tokens.
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { betterAuth } from 'better-auth';
import { isImportLinksResult } from '../packages/contracts/src/links';
import { isTokenScope, scopePresets } from '../packages/contracts/src/tokens';
import { setSlugReserved } from '../packages/data/src/links';
import { createIdentityAdapter } from '../packages/data/src/identity-adapter';
import { createTenant } from '../packages/data/src/tenancy';
import { createSessionOptions } from '../packages/server/src/auth/options';
import { createApiTokenPlugin, createToken } from '../packages/server/src/auth/api-tokens';
import { authenticateBearer, createApi, type ApiPrincipal } from '../packages/server/src/api';
import type { ProductEvent } from '../packages/server/src/events';
import { suspendTenant } from '../packages/server/src/operator';
import { createRedirectHandler } from '../packages/server/src/redirect';
import { projectPolicy } from '../packages/server/src/tenancy';
import { counting } from './support/d1-count';

const origin = 'https://app.example';
const identity = () => env.IMPORT_IDENTITY;
const routing = () => env.IMPORT_ROUTING;
const stores = () => ({ routing: routing(), analytics: { 'analytics-1': env.IMPORT_ANALYTICS } });
const clock = Date.UTC(2026, 9, 2, 10, 15);

// Tenants by user, for the test principal.
const tenantOf: Record<string, string> = {};

interface ApiOptions {
	importItemsPerRequest?: number;
	importsPerHour?: number;
	events?: ProductEvent[];
}

// x-test-scopes makes the principal an API token with those scopes; without it, a session.
function api(options: ApiOptions = {}) {
	const events = options.events;
	return createApi({
		identity: identity(),
		routing: routing(),
		appOrigin: origin,
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
			return {
				kind: 'session',
				sessionId: 'session-test',
				userId,
				signedInAt: new Date(clock).toISOString()
			};
		},
		now: () => clock,
		creationsPerMinute: 1000,
		importItemsPerRequest: options.importItemsPerRequest ?? 20,
		importsPerHour: options.importsPerHour,
		events: events ? { record: async (event) => void events.push(event) } : undefined
	});
}

let keyCounter = 0;
function nextKey() {
	keyCounter += 1;
	return `import-${keyCounter}`;
}

function post(
	user: string,
	path: string,
	body: unknown,
	headers: Record<string, string> = {},
	app = api()
) {
	return app.fetch(
		new Request(`${origin}${path}`, {
			method: 'POST',
			headers: { origin, 'content-type': 'application/json', 'x-test-user': user, ...headers },
			body: typeof body === 'string' ? body : JSON.stringify(body)
		})
	);
}

function importLinks(
	user: string,
	body: unknown,
	key: string | null = nextKey(),
	app = api(),
	headers: Record<string, string> = {}
) {
	return post(
		user,
		'/v1/links/import',
		body,
		key === null ? headers : { 'idempotency-key': key, ...headers },
		app
	);
}

async function json(response: Response) {
	return (await response.json()) as Record<string, any>;
}

async function codeOf(response: Response) {
	return (await json(response)).error.code as string;
}

async function addTenant(userId: string, tenantId: string, activeLinkLimit: number) {
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
		limits: { activeLinkLimit, monthlyClickLimit: 5000, retentionDays: 30, domainLimit: 1 },
		now: 1
	});
	await projectPolicy(identity(), stores(), tenantId, 1);
}

async function linkCount(tenantId: string) {
	const row = await routing()
		.prepare('SELECT COUNT(*) AS n FROM links WHERE tenant_id = ?')
		.bind(tenantId)
		.first<{ n: number }>();
	return row?.n ?? -1;
}

async function windowCount(tenantId: string) {
	const row = await routing()
		.prepare('SELECT SUM(count) AS n FROM creation_windows WHERE tenant_id = ?')
		.bind(`${tenantId}:imports`)
		.first<{ n: number | null }>();
	return row?.n ?? 0;
}

beforeAll(async () => {
	await applyD1Migrations(identity(), env.IDENTITY_MIGRATIONS, 'flared_core_migrations');
	await applyD1Migrations(routing(), env.ROUTING_MIGRATIONS, 'flared_core_migrations');
	await applyD1Migrations(env.IMPORT_ANALYTICS, env.ANALYTICS_MIGRATIONS, 'flared_core_migrations');
	await identity()
		.prepare("INSERT INTO installation (id, mode, created_at) VALUES (1, 'multi', 0)")
		.run();
	await routing().batch([
		routing().prepare(
			"INSERT INTO domain_namespaces (id, hostname, created_at) VALUES ('dom-short', 'short.example', 0), ('dom-other', 'other.example', 0)"
		),
		routing().prepare(
			"INSERT INTO domains (id, tenant_id, state, is_default, created_at, updated_at) VALUES ('dom-short', NULL, 'active', 1, 0, 0), ('dom-other', 'tenant-b', 'active', 0, 0, 0)"
		)
	]);
	await addTenant('user-a', 'tenant-a', 100);
	await addTenant('user-b', 'tenant-b', 100);
	await addTenant('user-small', 'tenant-small', 2);
	await addTenant('user-race', 'tenant-race', 3);
	await addTenant('user-window', 'tenant-window', 100);
	await addTenant('user-count', 'tenant-count', 100);
	await addTenant('user-suspended', 'tenant-suspended', 100);
	await setSlugReserved(routing(), 'brandword', true, clock);
	const taken = await post(
		'user-b',
		'/v1/links',
		{ destination: 'https://example.com/taken', slug: 'taken-slug' },
		{ 'idempotency-key': 'seed-taken' }
	);
	expect(taken.status).toBe(201);
});

// Items that fail on their own: a reserved slug, a taken slug, a slug repeated in the request,
// another workspace's domain, and an invalid destination.
const mixed = [
	{ destination: 'https://example.com/one', slug: 'mixed-one', title: 'One' },
	{ destination: 'https://example.com/reserved', slug: 'brandword' },
	{ destination: 'https://example.com/taken', slug: 'taken-slug' },
	{ destination: 'https://example.com/again', slug: 'mixed-one' },
	{ destination: 'https://example.com/foreign', domainId: 'dom-other' },
	{ destination: 'ftp://example.com/bad' },
	{ destination: 'https://example.com/two', iosDestination: 'myapp://two' }
];
const mixedFailures = [
	null,
	['SLUG_TAKEN', 'slug'],
	['SLUG_TAKEN', 'slug'],
	['SLUG_TAKEN', 'slug'],
	['DOMAIN_UNAVAILABLE', undefined],
	['INVALID_INPUT', 'destination'],
	null
];

function expectMixed(body: Record<string, any>, done: 'ready' | 'created') {
	expect(isImportLinksResult(body)).toBe(true);
	body.results.forEach((result: Record<string, any>, index: number) => {
		const failure = mixedFailures[index];
		expect(result.index).toBe(index);
		if (failure === null) expect(result.status, `item ${index}`).toBe(done);
		else {
			expect(result.status, `item ${index}`).toBe('failed');
			expect(result.error.code, `item ${index}`).toBe(failure[0]);
			expect(result.error.field, `item ${index}`).toBe(failure[1]);
		}
	});
	expect(body.summary).toEqual({ [done]: 2, failed: 5 });
}

describe('dry run', () => {
	it('reports each item as a real run would, and writes nothing', async () => {
		const before = await linkCount('tenant-a');
		const response = await importLinks('user-a', { dryRun: true, items: mixed });
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('no-store');
		const body = await json(response);
		expect(body.dryRun).toBe(true);
		expectMixed(body, 'ready');
		expect(body.results[0].link).toBeUndefined();
		expect(await linkCount('tenant-a')).toBe(before);
		expect(await windowCount('tenant-a')).toBe(0);
		const keys = await routing()
			.prepare("SELECT COUNT(*) AS n FROM idempotency_records WHERE key LIKE 'import-%'")
			.first<{ n: number }>();
		expect(keys?.n).toBe(0);
	});

	it('counts earlier ready items against the active link limit', async () => {
		const items = [1, 2, 3].map((index) => ({ destination: `https://example.com/d${index}` }));
		const body = await json(await importLinks('user-small', { dryRun: true, items }));
		expect(body.results.map((result: { status: string }) => result.status)).toEqual([
			'ready',
			'ready',
			'failed'
		]);
		expect(body.results[2].error.code).toBe('PLAN_LIMIT_REACHED');
		expect(await linkCount('tenant-small')).toBe(0);
	});
});

describe('real run', () => {
	const key = 'real-run-1';
	let first: string;

	it('creates the links in order, and they redirect', async () => {
		const events: ProductEvent[] = [];
		const app = api({ events });
		const before = await linkCount('tenant-a');
		const response = await importLinks('user-a', { dryRun: false, items: mixed }, key, app);
		expect(response.status).toBe(200);
		first = await response.clone().text();
		const body = await json(response);
		expect(body.dryRun).toBe(false);
		expectMixed(body, 'created');
		expect(body.results[0].link).toMatchObject({
			slug: 'mixed-one',
			title: 'One',
			shortUrl: 'https://short.example/mixed-one'
		});
		expect(body.results[6].link.iosDestination).toBe('myapp://two');
		expect(await linkCount('tenant-a')).toBe(before + 2);
		expect(await windowCount('tenant-a')).toBe(2);
		expect(events).toEqual([
			{ type: 'link_created', userId: 'user-a', tenantId: 'tenant-a', channel: 'web' },
			{ type: 'link_created', userId: 'user-a', tenantId: 'tenant-a', channel: 'web' }
		]);

		const redirects = createRedirectHandler({
			routing: routing(),
			appOrigin: origin,
			cacheName: 'import-redirects',
			now: () => clock
		});
		for (const result of [body.results[0], body.results[6]]) {
			const visit = await redirects.fetch(
				new Request(result.link.shortUrl, { redirect: 'manual' })
			);
			expect(visit.status).toBe(302);
			expect(visit.headers.get('location')).toBe(result.link.destination);
		}
	});

	it('replays the same results for the same key and creates nothing twice', async () => {
		const events: ProductEvent[] = [];
		const before = await linkCount('tenant-a');
		const replay = await importLinks(
			'user-a',
			{ dryRun: false, items: mixed },
			key,
			api({ events })
		);
		expect(replay.status).toBe(200);
		expect(await replay.text()).toBe(first);
		expect(await linkCount('tenant-a')).toBe(before);
		expect(await windowCount('tenant-a')).toBe(2);
		expect(events).toEqual([]);
		const rows = await routing()
			.prepare("SELECT COUNT(*) AS n FROM links WHERE slug = 'mixed-one'")
			.first<{ n: number }>();
		expect(rows?.n).toBe(1);
	});

	it('fails an item whose key was used for other input', async () => {
		const changed = mixed.map((item, index) =>
			index === 0 ? { ...item, title: 'Changed' } : item
		);
		const body = await json(await importLinks('user-a', { dryRun: false, items: changed }, key));
		expect(body.results[0]).toMatchObject({
			status: 'failed',
			error: { code: 'IDEMPOTENCY_KEY_REUSED' }
		});
		expect(body.results[6].status).toBe('created');
	});

	it('lets a workspace use its own domain and refuses it to others', async () => {
		const item = { destination: 'https://example.com/own', domainId: 'dom-other' };
		const own = await json(await importLinks('user-b', { dryRun: false, items: [item] }));
		expect(own.results[0].link.hostname).toBe('other.example');
		const foreign = await json(await importLinks('user-a', { dryRun: false, items: [item] }));
		expect(foreign.results[0].error.code).toBe('DOMAIN_UNAVAILABLE');
	});
});

describe('plan limit', () => {
	it('stops at the active link limit and reports the limit once', async () => {
		const events: ProductEvent[] = [];
		const items = [1, 2, 3, 4].map((index) => ({ destination: `https://example.com/s${index}` }));
		const body = await json(
			await importLinks('user-small', { dryRun: false, items }, nextKey(), api({ events }))
		);
		expect(body.results.map((result: { status: string }) => result.status)).toEqual([
			'created',
			'created',
			'failed',
			'failed'
		]);
		expect(body.results[3].error.code).toBe('PLAN_LIMIT_REACHED');
		expect(body.summary).toEqual({ created: 2, failed: 2 });
		expect(await linkCount('tenant-small')).toBe(2);
		expect(events.filter((event) => event.type === 'link_created')).toHaveLength(2);
		expect(events.filter((event) => event.type === 'limit_reached')).toEqual([
			{ type: 'limit_reached', userId: 'user-small', tenantId: 'tenant-small', limit: 'links' }
		]);
		expect(await windowCount('tenant-small')).toBe(2);
	});

	it('keeps a concurrent import and single create within the limit', async () => {
		const items = [1, 2, 3].map((index) => ({ destination: `https://example.com/r${index}` }));
		const [imported, single] = await Promise.all([
			importLinks('user-race', { dryRun: false, items }),
			post(
				'user-race',
				'/v1/links',
				{ destination: 'https://example.com/single' },
				{ 'idempotency-key': nextKey() }
			)
		]);
		const body = await json(imported);
		const created = body.summary.created + (single.status === 201 ? 1 : 0);
		expect(created).toBe(3);
		expect(await linkCount('tenant-race')).toBe(3);
	});
});

describe('request checks', () => {
	it('refuses a malformed request as a whole', async () => {
		const cases: [unknown, string, string][] = [
			[[], 'INVALID_IMPORT', 'body'],
			[{ items: [{ destination: 'https://e.com' }] }, 'INVALID_IMPORT', 'dryRun'],
			[{ dryRun: true, items: {} }, 'INVALID_IMPORT', 'items'],
			[{ dryRun: true, items: [] }, 'INVALID_IMPORT', 'items'],
			[
				{ dryRun: true, items: [{ destination: 'https://e.com' }], extra: 1 },
				'INVALID_IMPORT',
				'extra'
			]
		];
		for (const [body, code, field] of cases) {
			const response = await importLinks('user-a', body);
			expect(response.status, JSON.stringify(body)).toBe(400);
			expect((await json(response)).error).toMatchObject({ code, field });
		}
		const items = [1, 2, 3, 4].map((index) => ({ destination: `https://example.com/m${index}` }));
		const tooMany = await importLinks(
			'user-a',
			{ dryRun: false, items },
			nextKey(),
			api({ importItemsPerRequest: 3 })
		);
		expect(tooMany.status).toBe(400);
		expect(await codeOf(tooMany)).toBe('TOO_MANY_ITEMS');
	});

	it('refuses a body larger than the items allow', async () => {
		const before = await linkCount('tenant-a');
		const long = `https://example.com/${'a'.repeat(4000)}`;
		const items = [1, 2].map(() => ({
			destination: long,
			iosDestination: long,
			androidDestination: long,
			title: 'x'.repeat(100)
		}));
		const response = await importLinks(
			'user-a',
			{ dryRun: false, items },
			nextKey(),
			api({ importItemsPerRequest: 1 })
		);
		expect(response.status).toBe(413);
		expect(await codeOf(response)).toBe('PAYLOAD_TOO_LARGE');
		// The same body fits when the request may hold two items.
		const fits = await importLinks(
			'user-a',
			{ dryRun: true, items },
			nextKey(),
			api({ importItemsPerRequest: 2 })
		);
		expect(fits.status).toBe(200);
		expect(await linkCount('tenant-a')).toBe(before);
	});

	it('needs an Idempotency-Key, as a single create does', async () => {
		const response = await importLinks(
			'user-a',
			{ dryRun: false, items: [{ destination: 'https://example.com/k' }] },
			null
		);
		expect(response.status).toBe(422);
		expect(await codeOf(response)).toBe('IDEMPOTENCY_KEY_REQUIRED');
	});

	it('needs the links:write scope', async () => {
		const before = await linkCount('tenant-a');
		const body = { dryRun: false, items: [{ destination: 'https://example.com/scope' }] };
		const reader = await importLinks('user-a', body, nextKey(), api(), {
			'x-test-scopes': 'links:read'
		});
		expect(reader.status).toBe(403);
		expect(await codeOf(reader)).toBe('INSUFFICIENT_SCOPE');
		expect(await linkCount('tenant-a')).toBe(before);
		const writer = await importLinks('user-a', body, nextKey(), api(), {
			'x-test-scopes': 'links:read,links:write',
			'user-agent': 'flared-cli/0.6.0'
		});
		expect((await json(writer)).summary).toEqual({ created: 1, failed: 0 });
	});

	it('answers 405 for other methods', async () => {
		const response = await api().fetch(
			new Request(`${origin}/v1/links/import`, { headers: { 'x-test-user': 'user-a' } })
		);
		expect(response.status).toBe(405);
		expect(response.headers.get('allow')).toBe('POST');
	});

	it('refuses an import in a suspended workspace', async () => {
		await suspendTenant(identity(), stores(), { kind: 'operator', id: 'admin-1' } as const, {
			tenantId: 'tenant-suspended',
			reason: 'spam',
			now: clock
		});
		const body = { dryRun: true, items: [{ destination: 'https://example.com/s' }] };
		const principals: Record<string, string>[] = [{}, { 'x-test-scopes': 'links:write' }];
		for (const headers of principals) {
			const response = await importLinks('user-suspended', body, nextKey(), api(), headers);
			expect(response.status).toBe(403);
			expect(await codeOf(response)).toBe('WORKSPACE_SUSPENDED');
		}
		expect(await linkCount('tenant-suspended')).toBe(0);
	});
});

describe('hourly import window', () => {
	it('refuses a request that does not fit, creates nothing, and ignores dry runs', async () => {
		const app = api({ importsPerHour: 3 });
		const items = (prefix: string, count: number) =>
			Array.from({ length: count }, (_, index) => ({
				destination: `https://example.com/${prefix}${index}`
			}));
		const first = await importLinks(
			'user-window',
			{ dryRun: false, items: items('w', 2) },
			nextKey(),
			app
		);
		expect((await json(first)).summary).toEqual({ created: 2, failed: 0 });
		const refused = await importLinks(
			'user-window',
			{ dryRun: false, items: items('x', 2) },
			nextKey(),
			app
		);
		expect(refused.status).toBe(429);
		expect(await codeOf(refused)).toBe('RATE_LIMITED');
		// 10:15 UTC: the window ends at 11:00.
		expect(refused.headers.get('retry-after')).toBe(String(45 * 60));
		expect(await linkCount('tenant-window')).toBe(2);
		expect(await windowCount('tenant-window')).toBe(2);
		const preview = await importLinks(
			'user-window',
			{ dryRun: true, items: items('y', 3) },
			nextKey(),
			app
		);
		expect((await json(preview)).summary).toEqual({ ready: 3, failed: 0 });
		const last = await importLinks(
			'user-window',
			{ dryRun: false, items: items('z', 1) },
			nextKey(),
			app
		);
		expect((await json(last)).summary).toEqual({ created: 1, failed: 0 });
		expect(await windowCount('tenant-window')).toBe(3);
	});
});

describe('D1 query budget', () => {
	it('keeps a full request at the default size within 50 statements, replay included', async () => {
		const counter = { queries: 0 };
		const counted = counting(identity(), counter);
		const countedRouting = counting(routing(), counter);
		const auth = betterAuth({
			...createSessionOptions(origin),
			secret: 'test-only-auth-secret-at-least-thirty-two-characters',
			database: createIdentityAdapter(counted),
			rateLimit: { enabled: false },
			logger: { disabled: true },
			plugins: [createApiTokenPlugin()]
		});
		const { secret } = await createToken(auth, {
			userId: 'user-count',
			tenantId: 'tenant-count',
			input: { name: 'Import', scopes: scopePresets.full, expiresInDays: 30 }
		});
		const app = createApi({
			identity: counted,
			routing: countedRouting,
			appOrigin: origin,
			authenticate: (request) => authenticateBearer(auth, counted, request),
			now: () => clock,
			events: { record: async () => {} }
		});
		const send = (dryRun: boolean, items: unknown[], key: string) =>
			app.fetch(
				new Request(`${origin}/v1/links/import`, {
					method: 'POST',
					headers: {
						authorization: `Bearer ${secret}`,
						'content-type': 'application/json',
						'idempotency-key': key
					},
					body: JSON.stringify({ dryRun, items })
				})
			);
		const items = [1, 2, 3].map((index) => ({
			destination: `https://example.com/q${index}`,
			slug: `budget-${index}`
		}));
		const measure = async (dryRun: boolean, key: string) => {
			counter.queries = 0;
			const response = await send(dryRun, items, key);
			expect(response.status).toBe(200);
			return { queries: counter.queries, body: await json(response) };
		};
		const preview = await measure(true, 'budget-preview');
		const created = await measure(false, 'budget-1');
		const replayed = await measure(false, 'budget-1');
		expect(created.body.summary).toEqual({ created: 3, failed: 0 });
		expect(replayed.body).toEqual(created.body);
		// Measured when the default was set: 10 (dry run), 34 (created), 40 (replayed).
		for (const run of [preview, created, replayed]) expect(run.queries).toBeLessThan(50);
		// One more item would pass the budget on a replay; the default leaves no room for it.
		const tooMany = await send(false, [...items, { destination: 'https://e.com/4' }], 'budget-2');
		expect(tooMany.status).toBe(400);
	});
});
