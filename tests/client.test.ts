// SPDX-License-Identifier: AGPL-3.0-only
// The shared API client against the real /v1 API, D1, and API tokens.
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { betterAuth } from 'better-auth';
import { Validator, type Schema } from '@cfworker/json-schema';
import { openApiDocument } from '../packages/contracts/src/openapi';
import { scopePresets, tokenScopes } from '../packages/contracts/src/tokens';
import { createIdentityAdapter } from '../packages/data/src/identity-adapter';
import { createTenant } from '../packages/data/src/tenancy';
import { createSessionOptions } from '../packages/server/src/auth/options';
import { createApiTokenPlugin, createToken } from '../packages/server/src/auth/api-tokens';
import { authenticateBearer, createApi } from '../packages/server/src/api';
import { projectPolicy } from '../packages/server/src/tenancy';
import { writeExport } from '../packages/client/src/export';
import { utcDay } from '../packages/contracts/src/analytics';
import {
	FlaredApiError,
	createClient,
	normalizeBaseUrl,
	type ClientOptions
} from '../packages/client/src/client';

const origin = 'https://app.example';
const baseUrl = 'https://api.example/v1';
const identity = () => env.CLIENT_IDENTITY;
const routing = () => env.CLIENT_ROUTING;

const tokenAuth = () =>
	betterAuth({
		...createSessionOptions(origin),
		secret: 'test-only-auth-secret-at-least-thirty-two-characters',
		database: createIdentityAdapter(identity()),
		rateLimit: { enabled: false },
		logger: { disabled: true },
		plugins: [createApiTokenPlugin()]
	});

function api() {
	const auth = tokenAuth();
	return createApi({
		identity: identity(),
		routing: routing(),
		analytics: { 'analytics-1': env.CLIENT_ANALYTICS },
		appOrigin: origin,
		tokenAuth: auth,
		publicApiUrl: baseUrl,
		domains: {
			provider: {
				setup: 'dns',
				records: (hostname) => [{ type: 'CNAME', name: hostname, value: 'customers.example' }],
				start: async () => ({ status: 'waiting' }),
				check: async () => ({ status: 'ready' }),
				stop: async () => {}
			},
			reservedHostnames: ['brand.dev']
		},
		authenticate: async (request) => {
			if (request.headers.has('authorization'))
				return authenticateBearer(auth, identity(), request);
			const userId = request.headers.get('x-test-user');
			return userId
				? {
						kind: 'session',
						sessionId: 'session-test',
						userId,
						signedInAt: new Date().toISOString()
					}
				: null;
		}
	});
}

// The session-only dashboard routes, which the public description leaves out.
const sessionOnly = [
	'GET /tokens',
	'POST /tokens',
	'DELETE /tokens/{id}',
	'GET /connected-apps',
	'DELETE /connected-apps/{clientId}',
	'GET /workspace',
	'PATCH /workspace',
	'POST /workspaces/active',
	'GET /icons/{hostname}'
];
const document = openApiDocument(baseUrl);
type Operation = { responses: Record<string, { content?: Record<string, { schema: unknown }> }> };
const paths = document.paths as Record<string, Record<string, Operation>>;
// Each method, path template, and status seen in a response.
const seen = new Set<string>();

function template(pathname: string): string | null {
	const path = pathname.replace(/^\/v1/, '');
	return (
		Object.keys(paths).find((candidate) =>
			new RegExp(`^${candidate.replace(/\{[^}]+\}/g, '[^/]+')}$`).test(path)
		) ?? null
	);
}

// Checks a response body against its schema in the OpenAPI document.
async function conforms(request: Request, response: Response) {
	const path = template(new URL(request.url).pathname);
	const method = request.method.toLowerCase();
	const operation = path ? paths[path][method] : undefined;
	if (!path || !operation) throw new Error(`Undocumented ${request.method} ${request.url}`);
	const documented = operation.responses[String(response.status)] ?? operation.responses.default;
	const type = response.headers.get('content-type')?.split(';')[0] ?? '';
	if (response.status === 204 || type.startsWith('image/')) {
		if (response.status === 204 ? documented.content : !documented.content?.[type])
			throw new Error(`Undocumented ${type || 'empty'} body for ${method} ${path}`);
		seen.add(`${method} ${path} ${response.status}`);
		return;
	}
	const schema = documented.content?.['application/json']?.schema;
	if (!schema) throw new Error(`No schema for ${method} ${path} ${response.status}`);
	const root = { components: document.components, allOf: [schema] } as unknown as Schema;
	const result = new Validator(root, '2020-12', false).validate(await response.clone().json());
	if (!result.valid)
		throw new Error(`${method} ${path} ${response.status}: ${JSON.stringify(result.errors)}`);
	seen.add(`${method} ${path} ${response.status}`);
}

// Routes the client's requests into the API in process and checks each response.
const inProcess: typeof fetch = async (input, init) => {
	const request = new Request(input, init);
	const response = await api().fetch(request.clone());
	await conforms(request, response);
	return response;
};

let full = '';
let readOnly = '';
const waits: number[] = [];
function client(token = full, extra: Partial<ClientOptions> = {}) {
	return createClient({
		baseUrl,
		token,
		fetch: inProcess,
		sleep: async (milliseconds) => {
			waits.push(milliseconds);
		},
		...extra
	});
}

beforeAll(async () => {
	await applyD1Migrations(identity(), env.IDENTITY_MIGRATIONS, 'flared_core_migrations');
	await applyD1Migrations(routing(), env.ROUTING_MIGRATIONS, 'flared_core_migrations');
	await applyD1Migrations(env.CLIENT_ANALYTICS, env.ANALYTICS_MIGRATIONS, 'flared_core_migrations');
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
	await identity()
		.prepare(
			"INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('user-1', '', 'one@example.com', 1, 0, 0)"
		)
		.run();
	await createTenant(identity(), {
		id: 'tenant-1',
		name: 'Workspace',
		ownerUserId: 'user-1',
		analyticsShardId: 'analytics-1',
		limits: { activeLinkLimit: 100, monthlyClickLimit: 5000, retentionDays: 30, domainLimit: 1 },
		now: 1
	});
	await projectPolicy(
		identity(),
		{ routing: routing(), analytics: { 'analytics-1': env.CLIENT_ANALYTICS } },
		'tenant-1',
		1
	);
	const create = (name: string, scopes: typeof scopePresets.full) =>
		createToken(tokenAuth(), {
			userId: 'user-1',
			tenantId: 'tenant-1',
			input: { name, scopes, expiresInDays: 30 }
		});
	full = (await create('CLI', scopePresets.full)).secret;
	readOnly = (await create('Reader', scopePresets.read)).secret;
});

async function failureOf(promise: Promise<unknown>): Promise<FlaredApiError> {
	const error = await promise.then(
		() => null,
		(reason: unknown) => reason
	);
	if (!(error instanceof FlaredApiError)) throw new Error('Expected a FlaredApiError');
	return error;
}

describe('API client', () => {
	it('identifies the token and a session', async () => {
		const me = await client().me();
		expect(me).toMatchObject({ kind: 'token', scopes: scopePresets.full, token: { name: 'CLI' } });
		if (me.kind !== 'token') throw new Error('Expected a token identity');
		expect(full.startsWith(me.token.start)).toBe(true);
		expect(JSON.stringify(me)).not.toContain(full.slice(8));
		const session = await api().fetch(
			new Request(`${baseUrl}/me`, { headers: { 'x-test-user': 'user-1' } })
		);
		expect(await session.json()).toEqual({ kind: 'session', scopes: [...tokenScopes] });
	});

	it('creates, replays, lists, reads, edits, and measures links', async () => {
		const created = await client().createLink({
			destination: 'https://example.com/launch',
			slug: 'launch',
			idempotencyKey: 'launch-1'
		});
		expect(created.replayed).toBe(false);
		expect(created.link.shortUrl).toBe('https://short.example/launch');
		const again = await client().createLink({
			destination: 'https://example.com/launch',
			slug: 'launch',
			idempotencyKey: 'launch-1'
		});
		expect(again).toEqual({ link: created.link, replayed: true });

		const page = await client().listLinks({ search: 'launch', limit: 10 });
		expect(page.links.map((link) => link.id)).toEqual([created.link.id]);
		expect((await client().getLink(created.link.id)).destination).toBe(
			'https://example.com/launch'
		);
		const edited = await client().updateLink(created.link.id, { title: 'Launch', enabled: false });
		expect(edited).toMatchObject({ title: 'Launch', enabled: false });

		const analytics = await client().getAnalytics(created.link.id);
		expect(analytics.linkId).toBe(created.link.id);
		expect(analytics.total).toBe(0);
		expect((await client().getUsage()).clickLimit).toBe(5000);
	});

	it('writes the export pages into one JSON document', async () => {
		const { links } = await client().listLinks({ limit: 100 });
		const linkId = links[0]?.id;
		if (!linkId) throw new Error('Expected a link from the earlier test');
		const today = utcDay(Date.now());
		await env.CLIENT_ANALYTICS.batch([
			env.CLIENT_ANALYTICS.prepare(
				"INSERT INTO daily_totals (tenant_id, link_id, day, clicks) VALUES ('tenant-1', ?, ?, 4)"
			).bind(linkId, today),
			env.CLIENT_ANALYTICS.prepare(
				"INSERT INTO daily_dimensions (tenant_id, link_id, day, dimension, value, clicks) VALUES ('tenant-1', ?, ?, 'device', 'mobile', 4)"
			).bind(linkId, today)
		]);
		let text = '';
		const counts = await writeExport(client(readOnly), (part) => {
			text += part;
		});
		expect(counts).toEqual({ links: links.length, dailyTotals: 1, dailyDimensions: 1 });
		const file = JSON.parse(text) as Record<string, unknown>;
		expect(file).toMatchObject({
			format: 'flared.export/1',
			dailyTotals: [{ linkId, day: today, clicks: 4 }],
			dailyDimensions: [{ linkId, day: today, dimension: 'device', value: 'mobile', clicks: 4 }],
			retentionDays: 30
		});
		expect((file.links as { id: string }[]).map((link) => link.id)).toEqual(
			links.map((link) => link.id)
		);
	});

	it('turns API errors into typed errors without the token', async () => {
		const missing = await failureOf(client().getLink('missing'));
		expect(missing).toMatchObject({ code: 'NOT_FOUND', status: 404 });
		expect(missing.requestId).toMatch(/^[0-9a-f-]{36}$/);

		const scope = await failureOf(client(readOnly).createLink({ destination: 'https://e.com' }));
		expect(scope).toMatchObject({ code: 'INSUFFICIENT_SCOPE', status: 403 });

		const input = await failureOf(client().createLink({ destination: 'ftp://e.com' }));
		expect(input).toMatchObject({ code: 'INVALID_INPUT', status: 422, field: 'destination' });

		const bad = 'flr_' + 'x'.repeat(64);
		const unauthenticated = await failureOf(client(bad).me());
		expect(unauthenticated).toMatchObject({ code: 'UNAUTHENTICATED', status: 401 });
		for (const error of [missing, scope, input, unauthenticated])
			expect(`${error.message} ${error.stack}`).not.toContain(full.slice(8));
	});

	it('retries reads and keyed creates after 429 or 503, never edits', async () => {
		let calls = 0;
		let failNext = 0;
		let status = 503;
		const flaky: typeof fetch = async (input, init) => {
			calls += 1;
			if (failNext > 0) {
				failNext -= 1;
				return Response.json(
					{ error: { code: status === 429 ? 'RATE_LIMITED' : 'SERVICE_UNAVAILABLE' } },
					{ status, headers: status === 429 ? { 'retry-after': '5' } : {} }
				);
			}
			return inProcess(input, init);
		};
		waits.length = 0;
		failNext = 1;
		const created = await client(full, { fetch: flaky }).createLink({
			destination: 'https://example.com/retry',
			idempotencyKey: 'retry-1'
		});
		expect(calls).toBe(2);
		expect(waits).toEqual([1000]);

		status = 429;
		failNext = 1;
		waits.length = 0;
		await client(full, { fetch: flaky }).getUsage();
		expect(waits).toEqual([5000]);

		status = 503;
		failNext = 1;
		calls = 0;
		const edit = await failureOf(
			client(full, { fetch: flaky }).updateLink(created.link.id, { title: 'x' })
		);
		expect(edit.code).toBe('SERVICE_UNAVAILABLE');
		expect(calls).toBe(1);

		failNext = 5;
		calls = 0;
		expect((await failureOf(client(full, { fetch: flaky }).getUsage())).status).toBe(503);
		expect(calls).toBe(3);
		failNext = 0;
	});

	it('reports network failures and rejects unsafe API URLs', async () => {
		let calls = 0;
		const offline: typeof fetch = async () => {
			calls += 1;
			throw new TypeError('fetch failed');
		};
		const error = await failureOf(client(full, { fetch: offline }).getUsage());
		expect(error).toMatchObject({ code: 'NETWORK_ERROR', status: null });
		expect(calls).toBe(3);

		expect(normalizeBaseUrl('https://api.flared.page/v1/')).toBe('https://api.flared.page/v1');
		expect(normalizeBaseUrl('http://localhost:8787/v1')).toBe('http://localhost:8787/v1');
		for (const unsafe of [
			'http://api.flared.page/v1',
			'https://user:pass@api.flared.page/v1',
			'https://api.flared.page/v1?x=1',
			'api.flared.page'
		])
			expect(() => normalizeBaseUrl(unsafe), unsafe).toThrow();
	});
});

describe('domains and QR codes', () => {
	const raw = (path: string, token = full) =>
		inProcess(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });

	it('adds, reads, checks, and removes a domain', async () => {
		const before = await client().listDomains();
		expect(before).toMatchObject({ used: 0, limit: 1 });
		expect(before.domains.map((domain) => domain.hostname)).toEqual(['short.example']);

		const added = await client().addDomain('go.client.example.com');
		expect(added).toMatchObject({ created: true, domain: { state: 'pending' } });
		const again = await client().addDomain('go.client.example.com');
		expect(again).toMatchObject({ created: false, domain: { id: added.domain.id } });

		const read = await raw(`/domains/${added.domain.id}`);
		expect(read.status).toBe(200);
		expect((await client().checkDomain(added.domain.id)).state).toBe('active');

		const refused = await failureOf(client(readOnly).addDomain('go.reader.example.com'));
		expect(refused.code).toBe('INSUFFICIENT_SCOPE');
		const taken = await failureOf(client().addDomain('go.brand.dev'));
		expect(taken.code).toBe('DOMAIN_TAKEN');

		await client().removeDomain(added.domain.id);
		expect((await client().listDomains()).used).toBe(0);
		const gone = await failureOf(client().checkDomain(added.domain.id));
		expect(gone.code).toBe('NOT_FOUND');
	});

	it('serves QR codes as SVG and PNG', async () => {
		const { link } = await client().createLink({ destination: 'https://example.com/qr' });
		const svg = await raw(`/links/${link.id}/qr`);
		expect(svg.headers.get('content-type')).toBe('image/svg+xml');
		const png = await raw(`/links/${link.id}/qr?format=png`, readOnly);
		expect(png.headers.get('content-type')).toBe('image/png');
	});
});

describe('OpenAPI document', () => {
	it('describes exactly the public routes of the API', () => {
		const served = api()
			.routes.filter((route) => route.method !== 'ALL')
			.map(
				(route) => `${route.method} ${route.path.replace(/^\/v1/, '').replace(/:(\w+)/g, '{$1}')}`
			);
		const documented = Object.entries(paths).flatMap(([path, methods]) =>
			Object.keys(methods).map((method) => `${method.toUpperCase()} ${path}`)
		);
		expect(new Set(served)).toEqual(new Set([...documented, ...sessionOnly]));
	});

	it('is served without a token and matched every success response above', async () => {
		const response = await api().fetch(new Request(`${baseUrl}/openapi.json`));
		expect(response.status).toBe(200);
		const body = (await response.json()) as { servers: { url: string }[] };
		expect(body.servers).toEqual([{ url: baseUrl }]);
		for (const [path, methods] of Object.entries(paths))
			for (const [method, operation] of Object.entries(methods))
				for (const status of Object.keys(operation.responses))
					if (status !== 'default' && path !== '/openapi.json')
						expect(seen.has(`${method} ${path} ${status}`), `${method} ${path} ${status}`).toBe(
							true
						);
		expect([...seen].some((entry) => / 4\d\d$/.test(entry))).toBe(true);
	});
});
