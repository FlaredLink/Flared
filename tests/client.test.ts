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
		automations: { email: false, destinationChecks: false },
		previewImages: env.PREVIEW_IMAGES,
		pages: { host: 'pages.example' },
		pageImages: env.PAGE_IMAGES,
		webhooks: {
			secret: 'test-only-client-webhook-secret',
			hooks: { allowedHosts: ['hooks.zapier.com'] }
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
	'GET /workspaces',
	'POST /workspaces',
	'POST /workspaces/active',
	'GET /icons/{hostname}',
	'GET /members',
	'POST /invites',
	'POST /invites/lookup',
	'POST /invites/accept',
	'POST /invites/{id}/resend',
	'DELETE /invites/{id}',
	'DELETE /members/{userId}',
	'POST /workspace/leave',
	'POST /workspace/transfer',
	'DELETE /workspace/transfer',
	'POST /workspace/transfer/accept',
	'POST /members/{userId}/password-reset',
	'GET /webhooks',
	'POST /webhooks',
	'PATCH /webhooks/{id}',
	'DELETE /webhooks/{id}',
	'POST /webhooks/{id}/secret',
	'POST /webhooks/{id}/test',
	'GET /webhooks/{id}/deliveries',
	'POST /automations',
	'PATCH /automations/{id}',
	'DELETE /automations/{id}',
	'GET /automations/{id}/runs'
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
		limits: {
			activeLinkLimit: 100,
			monthlyClickLimit: 5000,
			retentionDays: 30,
			domainLimit: 1,
			automationLimit: 5,
			webhookEndpointLimit: 5,
			linkPreviews: 1,
			pageLimit: 2,
			pageExtras: 1
		},
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
		expect(await session.json()).toEqual({
			kind: 'session',
			scopes: [...tokenScopes],
			workspace: { id: 'tenant-1', name: 'Workspace', role: 'owner' }
		});
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

	it('imports links in bulk, with a dry run first and a safe retry', async () => {
		const items = [
			{ destination: 'https://example.com/bulk-1', slug: 'bulk-one' },
			{ destination: 'https://example.com/bulk-2', slug: 'launch' }
		];
		const preview = await client().importLinks({ dryRun: true, items });
		expect(preview.results.map((result) => result.status)).toEqual(['ready', 'failed']);
		expect(preview.summary).toEqual({ ready: 1, failed: 1 });
		const run = await client().importLinks({ dryRun: false, items, idempotencyKey: 'bulk-1' });
		expect(run.results[0].link?.shortUrl).toBe('https://short.example/bulk-one');
		expect(run.results[1].error).toMatchObject({ code: 'SLUG_TAKEN', field: 'slug' });
		const again = await client().importLinks({ dryRun: false, items, idempotencyKey: 'bulk-1' });
		expect(again).toEqual(run);
		const refused = await failureOf(client(readOnly).importLinks({ dryRun: true, items }));
		expect(refused.code).toBe('INSUFFICIENT_SCOPE');
	});

	it('subscribes a hook and deletes it', async () => {
		const headers = { authorization: `Bearer ${full}`, 'content-type': 'application/json' };
		const created = await inProcess(`${baseUrl}/hooks`, {
			method: 'POST',
			headers,
			body: JSON.stringify({
				event: 'link.created',
				targetUrl: 'https://hooks.zapier.com/hooks/standard/1/client/'
			})
		});
		expect(created.status).toBe(201);
		const { hook } = (await created.json()) as { hook: { id: string } };
		// The hook names the token's ID, the one DELETE /v1/tokens/{id} takes.
		const me = await client().me();
		if (me.kind !== 'token') throw new Error('Expected a token identity');
		const row = await routing()
			.prepare('SELECT target FROM webhook_endpoints WHERE id = ?')
			.bind(hook.id)
			.first<{ target: string }>();
		expect(JSON.parse(row?.target ?? 'null')).toEqual({
			userId: 'user-1',
			credential: `token:${me.token.id}`
		});
		const listed = await api().fetch(
			new Request(`${baseUrl}/tokens`, { headers: { 'x-test-user': 'user-1' } })
		);
		const tokens = ((await listed.json()) as { tokens: { id: string }[] }).tokens;
		expect(tokens.map((item) => item.id)).toContain(me.token.id);
		const path = `${baseUrl}/hooks/${hook.id}`;
		expect((await inProcess(path, { method: 'DELETE', headers })).status).toBe(204);
		expect((await inProcess(path, { method: 'DELETE', headers })).status).toBe(404);
	});

	it('lists automations, applies one to links, and takes it off again', async () => {
		// Templates are made in the dashboard: a session-only route outside the public API.
		const created = await api().fetch(
			new Request(`${baseUrl}/automations`, {
				method: 'POST',
				headers: { 'x-test-user': 'user-1', origin, 'content-type': 'application/json' },
				body: JSON.stringify({
					name: 'Retire',
					trigger: { type: 'link_age', days: 30 },
					actions: [{ type: 'disable_link' }]
				})
			})
		);
		expect(created.status).toBe(201);
		const { automation } = (await created.json()) as { automation: { id: string } };
		const page = await client().listAutomations();
		expect(page).toMatchObject({ used: 1, limit: 5, perLinkLimit: 5 });
		expect(page.actionTypes).not.toContain('email_owner');
		expect(page.triggerTypes).not.toContain('destination_down');
		const { link } = await client().createLink({ destination: 'https://example.com/auto' });
		const applied = await client().applyAutomation(automation.id, [link.id, 'lnk_missing']);
		expect(applied.results).toEqual([
			{ linkId: link.id, status: 'applied' },
			{
				linkId: 'lnk_missing',
				status: 'failed',
				error: { code: 'NOT_FOUND', message: 'Link not found.' }
			}
		]);
		const listed = await client().listLinkAutomations(link.id);
		expect(listed.automations).toMatchObject([
			{ automationId: automation.id, state: 'waiting', result: null, check: null }
		]);
		const path = `${baseUrl}/links/${link.id}/automations/${automation.id}`;
		const authorization = `Bearer ${full}`;
		const again = await inProcess(path, { method: 'PUT', headers: { authorization } });
		expect(again.status).toBe(200);
		expect(await again.json()).toMatchObject({ linkId: link.id, status: 'unchanged' });
		const dated = await inProcess(path, {
			method: 'PUT',
			headers: { authorization, 'content-type': 'application/json' },
			body: JSON.stringify({ endsAt: '2026-11-01T09:00:00Z' })
		});
		expect(dated.status).toBe(422);
		const refused = await failureOf(client(readOnly).applyAutomation(automation.id, [link.id]));
		expect(refused.code).toBe('INSUFFICIENT_SCOPE');
		await client().removeLinkAutomation(link.id, automation.id);
		expect((await client().listLinkAutomations(link.id)).automations).toEqual([]);
		const gone = await failureOf(client().removeLinkAutomation(link.id, automation.id));
		expect(gone.code).toBe('NOT_FOUND');
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

	// The earlier tests leave three links.
	it('asks for a link export page size only when given one', async () => {
		const asked: string[] = [];
		const recording: typeof fetch = async (input, init) => {
			const request = new Request(input, init);
			asked.push(new URL(request.url).search);
			return inProcess(request);
		};
		const reader = client(readOnly, { fetch: recording });
		const first = await reader.exportLinks(undefined, 2);
		expect(first.links).toHaveLength(2);
		expect(first.nextCursor).toEqual(expect.any(String));
		const cursor = first.nextCursor ?? '';
		await reader.exportLinks(cursor);
		expect(asked).toEqual(['?limit=2', `?cursor=${encodeURIComponent(cursor)}`]);
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

	it('sets and removes the image of a link card', async () => {
		const { link } = await client().createLink({
			destination: 'https://example.com/card',
			previewTitle: 'Card title'
		});
		const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
		const withImage = await client().setPreviewImage(link.id, { body: png, type: 'image/png' });
		expect(withImage.previewImage).toMatch(/\/preview\/[A-Za-z0-9_-]{22}\.png$/);
		const without = await client().removePreviewImage(link.id);
		expect(without.previewImage).toBeNull();
		expect(without.previewTitle).toBe('Card title');
	});

	it('creates, lists, reads, edits, and deletes a page', async () => {
		const { link } = await client().createLink({ destination: 'https://buy.stripe.com/test_page' });
		const page = await client().createPage({
			handle: 'client-page',
			title: 'Shop',
			theme: { id: 'ember', buttonShape: 'square' },
			blocks: [
				{ kind: 'header', label: 'New', startsAt: '2026-01-01T00:00:00Z' },
				{ kind: 'button', linkId: link.id, label: 'Buy' },
				{ kind: 'payment', linkId: link.id, provider: 'stripe', label: 'Guide', price: 'US$9' },
				{ kind: 'social', links: [{ network: 'github', address: 'https://github.com/flared' }] },
				{ kind: 'embed', provider: 'youtube', address: 'https://youtu.be/dQw4w9WgXcQ' },
				{ kind: 'signup', label: 'News', buttonLabel: 'Join' }
			]
		});
		expect(page.blocks.map((block) => block.kind)).toEqual([
			'header',
			'button',
			'payment',
			'social',
			'embed',
			'signup'
		]);
		expect((await client(readOnly).listPages()).pages.map((item) => item.id)).toContain(page.id);
		expect((await client(readOnly).getPage(page.id)).title).toBe('Shop');
		const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
		for (const slot of ['avatar', 'background'] as const) {
			const withImage = await client().setPageImage(page.id, slot, {
				body: png,
				type: 'image/png'
			});
			expect(withImage[`${slot}Image`]).toMatch(
				/^https:\/\/client-page\.pages\.example\/_image\/[A-Za-z0-9_-]{22}\.png$/
			);
			expect((await client().removePageImage(page.id, slot))[`${slot}Image`]).toBeNull();
		}
		const analytics = await client(readOnly).getPageAnalytics(page.id);
		expect(analytics).toMatchObject({ pageId: page.id, views: 0 });
		expect(analytics.buttons.map((button) => button.label)).toEqual(['Buy', 'Guide']);
		const changed = await client().updatePage(page.id, { title: 'Store', blocks: [] });
		expect(changed).toMatchObject({ title: 'Store', blocks: [] });
		await client().deletePage(page.id);
		await expect(client().getPage(page.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
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
