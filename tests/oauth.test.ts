// SPDX-License-Identifier: AGPL-3.0-only
// The OAuth authorization server routes and the MCP endpoint under workerd and D1.
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { makeSignature } from 'better-auth/crypto';
import { createTenant, setActiveWorkspace } from '../packages/data/src/tenancy';
import { setLinkBlock } from '../packages/data/src/links';
import { deleteGrant, deleteExpiredOAuthRecords } from '../packages/data/src/oauth';
import { projectPolicy } from '../packages/server/src/tenancy';
import { reinstateTenant, suspendTenant } from '../packages/server/src/operator';
import { createApi, type ApiPrincipal } from '../packages/server/src/api';
import type { DomainProvider } from '../packages/server/src/domains';
import { qrPng } from '../packages/client/src/qr';
import type { ProductEvent } from '../packages/server/src/events';
import {
	createMcpEndpoint,
	mcpCallsPerMinute,
	mcpExportResultBytes,
	mcpImportItemsPerCall,
	mcpServerCard
} from '../packages/server/src/mcp';
import { createMetadataFetch, type OAuthServerConfig } from '../packages/server/src/oauth/provider';
import { createOAuthRoutes, registrationsPerSourceHour } from '../packages/server/src/oauth/routes';
import { knownAssistant, resumeAuthorizationPath } from '../packages/contracts/src/oauth';
import { counting } from './support/d1-count';

const origin = 'https://app.example';
const resource = 'https://api.example/mcp';
const secret = 'test-only-auth-secret-at-least-thirty-two-characters';
const identity = () => env.OAUTH_IDENTITY;
const routing = () => env.OAUTH_ROUTING;
const redirectUri = 'https://client.example/callback';
const cimdClientId = 'https://assistant.example/oauth/client.json';

// The client metadata documents the test network serves.
const documents = new Map<string, unknown>([
	[
		cimdClientId,
		{
			client_id: cimdClientId,
			client_name: 'Assistant',
			client_uri: 'https://assistant.example',
			redirect_uris: ['https://assistant.example/callback'],
			token_endpoint_auth_method: 'none'
		}
	],
	[
		'https://mismatch.example/client.json',
		{
			client_id: 'https://other.example/client.json',
			client_name: 'Mismatch',
			redirect_uris: ['https://mismatch.example/callback']
		}
	]
]);
const fetched: string[] = [];
const config: OAuthServerConfig = {
	origin,
	secret,
	resource,
	loginPath: '/app/login',
	consentPath: '/app/oauth/consent',
	async fetchClientMetadata(input) {
		const url = String(input instanceof Request ? input.url : input);
		fetched.push(url);
		const document = documents.get(url);
		return document
			? Response.json(document, { headers: { 'cache-control': 'no-store' } })
			: new Response('not found', { status: 404 });
	}
};
// What the event hook received, for the approval and tool-call checks.
const productEvents: ProductEvent[] = [];
const events = { record: async (event: ProductEvent) => void productEvents.push(event) };
const oauth = () =>
	createOAuthRoutes({
		db: identity(),
		config,
		sourceKey: async (request) => request.headers.get('x-test-source') ?? 'source-default',
		identityRule: { kind: 'verified-email' },
		events
	});

// Only the records matter here: no MCP tool adds, checks, or removes a domain.
const domainProvider: DomainProvider = {
	setup: 'dns',
	records: (hostname) => [{ type: 'CNAME', name: hostname, value: 'customers.short.example' }],
	start: async () => ({ status: 'waiting' }),
	check: async () => ({ status: 'waiting' }),
	stop: async () => {}
};

function api(principal: ApiPrincipal) {
	return createApi({
		identity: identity(),
		routing: routing(),
		analytics: { 'analytics-1': env.OAUTH_ANALYTICS },
		appOrigin: origin,
		domains: { provider: domainProvider, reservedHostnames: ['short.example'] },
		authenticate: async () => principal
	});
}
const mcp = () =>
	createMcpEndpoint({
		identity: identity(),
		resource,
		issuer: origin,
		allowedOrigins: [origin],
		api,
		events
	});

async function addTenant(userId: string, tenantId: string) {
	await identity()
		.prepare(
			'INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 0, 0)'
		)
		.bind(userId, '', `${userId}@example.com`)
		.run();
	await addWorkspace(userId, tenantId, 'Workspace');
}

async function addWorkspace(userId: string, tenantId: string, name: string) {
	await createTenant(identity(), {
		id: tenantId,
		name,
		ownerUserId: userId,
		analyticsShardId: 'analytics-1',
		limits: { activeLinkLimit: 100, monthlyClickLimit: 5000, retentionDays: 30, domainLimit: 1 },
		now: 1
	});
	await projectPolicy(
		identity(),
		{ routing: routing(), analytics: { 'analytics-1': env.OAUTH_ANALYTICS } },
		tenantId,
		1
	);
}

// A signed session cookie for the user, as the sign-in instance sets it.
async function sessionCookie(userId: string): Promise<string> {
	const token = crypto.randomUUID().replace(/-/g, '');
	const now = Date.now();
	await identity()
		.prepare(
			'INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, userId) VALUES (?, ?, ?, ?, ?, ?)'
		)
		.bind(crypto.randomUUID(), now + 86_400_000, token, now, now, userId)
		.run();
	const signature = await makeSignature(token, secret);
	return `__Secure-better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`;
}

async function challenge(verifier: string): Promise<string> {
	const digest = new Uint8Array(
		await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
	);
	let binary = '';
	for (const byte of digest) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const form = (fields: Record<string, string>) =>
	new Request(`${origin}/oauth2/token`, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams(fields)
	});

async function register(source = crypto.randomUUID(), uris = [redirectUri]): Promise<string> {
	const response = await oauth().fetch(
		new Request(`${origin}/oauth2/register`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-test-source': source },
			body: JSON.stringify({
				redirect_uris: uris,
				token_endpoint_auth_method: 'none',
				client_name: 'Test client'
			})
		})
	);
	expect(response.status).toBe(201);
	return String(((await response.json()) as Record<string, unknown>).client_id);
}

interface Flow {
	clientId: string;
	cookie: string;
	verifier: string;
	query: URLSearchParams;
	// The workspace the consent approves.
	workspace: string;
}

async function startFlow(
	userId: string,
	options: {
		clientId?: string;
		scope?: string;
		redirect?: string;
		cookie?: string;
		workspace?: string;
	} = {}
): Promise<Flow> {
	const clientId = options.clientId ?? (await register());
	const cookie = options.cookie ?? (await sessionCookie(userId));
	const verifier = crypto.randomUUID() + crypto.randomUUID();
	const query = new URLSearchParams({
		response_type: 'code',
		client_id: clientId,
		redirect_uri: options.redirect ?? redirectUri,
		scope: options.scope ?? 'links:read links:write analytics:read usage:read offline_access',
		state: 'state-1',
		code_challenge: await challenge(verifier),
		code_challenge_method: 'S256',
		resource
	});
	// Each test user-N owns tenant-N.
	return {
		clientId,
		cookie,
		verifier,
		query,
		workspace: options.workspace ?? userId.replace('user-', 'tenant-')
	};
}

async function authorize(flow: Flow): Promise<Response> {
	return oauth().fetch(
		new Request(`${origin}/oauth2/authorize?${flow.query}`, { headers: { cookie: flow.cookie } })
	);
}

async function approve(flow: Flow, accept = true): Promise<URL> {
	const location = (await authorize(flow)).headers.get('location') ?? '';
	expect(location.startsWith('/app/oauth/consent?')).toBe(true);
	const response = await oauth().fetch(
		new Request(`${origin}/oauth2/consent`, {
			method: 'POST',
			headers: { cookie: flow.cookie, origin, 'content-type': 'application/json' },
			body: JSON.stringify({
				accept,
				oauth_query: location.slice(location.indexOf('?') + 1),
				workspace_id: flow.workspace
			})
		})
	);
	expect(response.status).toBe(200);
	return new URL(String(((await response.json()) as Record<string, unknown>).redirectTo));
}

async function exchange(flow: Flow, code: string, extra: Record<string, string> = {}) {
	return oauth().fetch(
		form({
			grant_type: 'authorization_code',
			code,
			code_verifier: flow.verifier,
			redirect_uri: flow.query.get('redirect_uri') ?? '',
			client_id: flow.clientId,
			resource,
			...extra
		})
	);
}

interface Tokens {
	access_token: string;
	refresh_token: string;
	scope: string;
}

async function connect(userId: string, scope?: string): Promise<Flow & { tokens: Tokens }> {
	const flow = await startFlow(userId, { scope });
	const callback = await approve(flow);
	const response = await exchange(flow, callback.searchParams.get('code') ?? '');
	expect(response.status).toBe(200);
	return { ...flow, tokens: (await response.json()) as Tokens };
}

let rpcId = 0;
function rpc(token: string | null, method: string, params: Record<string, unknown> = {}) {
	const headers: Record<string, string> = {
		'content-type': 'application/json',
		accept: 'application/json, text/event-stream',
		'mcp-protocol-version': '2026-07-28',
		'mcp-method': method
	};
	if (typeof params.name === 'string') headers['mcp-name'] = params.name;
	if (token) headers.authorization = `Bearer ${token}`;
	return new Request(resource, {
		method: 'POST',
		headers,
		body: JSON.stringify({
			jsonrpc: '2.0',
			id: (rpcId += 1),
			method,
			params: {
				...params,
				_meta: {
					'io.modelcontextprotocol/protocolVersion': '2026-07-28',
					'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1.0.0' },
					'io.modelcontextprotocol/clientCapabilities': {}
				}
			}
		})
	});
}

async function call(token: string, name: string, args: Record<string, unknown> = {}) {
	const response = await mcp()(rpc(token, 'tools/call', { name, arguments: args }));
	const body = (await response.json()) as {
		result?: {
			structuredContent?: Record<string, unknown>;
			isError?: boolean;
			content: { type: string; text?: string; data?: string; mimeType?: string }[];
		};
		error?: unknown;
	};
	return { status: response.status, body, headers: response.headers };
}

interface ExportedPage {
	links: { id: string; status: string; item: Record<string, unknown> }[];
	nextCursor: string | null;
}

async function exportPage(token: string, args: Record<string, unknown> = {}) {
	const response = await call(token, 'export_links', args);
	expect(response.status).toBe(200);
	const text = response.body.result?.content[0].text ?? '';
	return { page: response.body.result?.structuredContent as unknown as ExportedPage, text };
}

beforeAll(async () => {
	await applyD1Migrations(identity(), env.IDENTITY_MIGRATIONS, 'flared_core_migrations');
	await identity()
		.prepare("INSERT INTO installation (id, mode, created_at) VALUES (1, 'multi', 0)")
		.run();
	await applyD1Migrations(routing(), env.ROUTING_MIGRATIONS, 'flared_core_migrations');
	await applyD1Migrations(env.OAUTH_ANALYTICS, env.ANALYTICS_MIGRATIONS, 'flared_core_migrations');
	await routing().batch([
		routing().prepare(
			"INSERT INTO domain_namespaces (id, hostname, created_at) VALUES ('dom-short', 'short.example', 0)"
		),
		routing().prepare(
			"INSERT INTO domains (id, tenant_id, state, is_default, created_at, updated_at) VALUES ('dom-short', NULL, 'active', 1, 0, 0)"
		)
	]);
	for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9]) await addTenant(`user-${n}`, `tenant-${n}`);
	// Workspace domains for tenant-8, and one of tenant-5's that tenant-8 must not see.
	const later = Date.now() + 86_400_000;
	for (const [id, hostname, tenant, state] of [
		['dom-brand', 'go.brand.com', 'tenant-8', 'active'],
		['dom-shop', 'links.shop.com', 'tenant-8', 'pending'],
		['dom-other', 'go.other.com', 'tenant-5', 'active']
	])
		await routing().batch([
			routing()
				.prepare('INSERT INTO domain_namespaces (id, hostname, created_at) VALUES (?, ?, 0)')
				.bind(id, hostname),
			routing()
				.prepare(
					'INSERT INTO domains (id, tenant_id, state, is_default, created_at, updated_at, claimed_at, claim_expires_at, activated_at) VALUES (?, ?, ?, 0, 1, 1, 1, ?, ?)'
				)
				.bind(id, tenant, state, state === 'active' ? null : later, state === 'active' ? 1 : null)
		]);
});

describe('authorization server', () => {
	it('publishes metadata for PKCE S256, issuer responses, CIMD, and public clients only where served', async () => {
		const response = await oauth().fetch(
			new Request(`${origin}/.well-known/oauth-authorization-server`)
		);
		expect(response.status).toBe(200);
		const metadata = (await response.json()) as Record<string, unknown>;
		expect(metadata).toMatchObject({
			issuer: origin,
			authorization_endpoint: `${origin}/oauth2/authorize`,
			token_endpoint: `${origin}/oauth2/token`,
			registration_endpoint: `${origin}/oauth2/register`,
			revocation_endpoint: `${origin}/oauth2/revoke`,
			code_challenge_methods_supported: ['S256'],
			authorization_response_iss_parameter_supported: true,
			client_id_metadata_document_supported: true,
			grant_types_supported: ['authorization_code', 'refresh_token'],
			response_types_supported: ['code']
		});
		expect(metadata.token_endpoint_auth_methods_supported).toContain('none');
		expect(metadata).not.toHaveProperty('introspection_endpoint');
		expect(metadata).not.toHaveProperty('dpop_signing_alg_values_supported');
		for (const path of [
			'/oauth2/introspect',
			'/oauth2/get-clients',
			'/oauth2/create-client',
			'/oauth2/get-consents',
			'/oauth2/userinfo',
			'/admin/oauth2/resources',
			'/sign-out'
		])
			expect((await oauth().fetch(new Request(`${origin}${path}`))).status).toBe(404);
	});

	it('sends a signed-out person to sign-in and resumes the same request afterwards', async () => {
		const flow = await startFlow('user-1', { cookie: '' });
		const response = await authorize(flow);
		expect(response.status).toBe(302);
		const location = response.headers.get('location') ?? '';
		expect(location.startsWith('/app/login?')).toBe(true);
		const resumed = resumeAuthorizationPath(location.slice(location.indexOf('?') + 1)) ?? '';
		expect(resumed.startsWith('/oauth2/authorize?')).toBe(true);
		const params = new URL(resumed, origin).searchParams;
		expect(params.get('client_id')).toBe(flow.clientId);
		expect(params.has('sig')).toBe(false);
		expect(resumeAuthorizationPath('client_id=x')).toBeNull();
	});

	it('issues a workspace-bound, audience-bound token pair through consent and stores only hashes', async () => {
		const flow = await startFlow('user-1');
		const location = (await authorize(flow)).headers.get('location') ?? '';
		const details = await oauth().fetch(
			new Request(`${origin}/oauth2/consent/request?${location.slice(location.indexOf('?') + 1)}`, {
				headers: { cookie: flow.cookie }
			})
		);
		expect(await details.json()).toEqual({
			client: { name: 'Test client', uri: null },
			redirectHost: 'client.example',
			redirectLoopback: false,
			scopes: ['links:read', 'links:write', 'analytics:read', 'usage:read'],
			offlineAccess: true,
			workspaces: [{ id: 'tenant-1', name: 'Workspace' }],
			selectedWorkspaceId: 'tenant-1'
		});
		productEvents.length = 0;
		const callback = await approve(flow);
		expect(productEvents).toEqual([
			{
				type: 'assistant_connected',
				userId: 'user-1',
				tenantId: 'tenant-1',
				clientId: flow.clientId,
				clientName: 'Test client'
			}
		]);
		expect(callback.origin + callback.pathname).toBe(redirectUri);
		expect(callback.searchParams.get('iss')).toBe(origin);
		expect(callback.searchParams.get('state')).toBe('state-1');
		const response = await exchange(flow, callback.searchParams.get('code') ?? '');
		expect(response.status).toBe(200);
		const tokens = (await response.json()) as Tokens & { expires_in: number };
		expect(tokens.access_token).toMatch(/^flo_at_/);
		expect(tokens.refresh_token).toMatch(/^flo_rt_/);
		expect(tokens.expires_in).toBe(3600);
		const rows = JSON.stringify(
			(await identity().prepare('SELECT * FROM oauthAccessToken').all()).results
		);
		expect(rows).not.toContain(tokens.access_token.slice(7));
		const stored = await identity()
			.prepare('SELECT referenceId, resources FROM oauthAccessToken WHERE clientId = ?')
			.bind(flow.clientId)
			.first<Record<string, string>>();
		expect(stored).toEqual({ referenceId: 'tenant-1', resources: JSON.stringify([resource]) });
	});

	it('lets a person with several workspaces bind the grant to the one they choose', async () => {
		await addTenant('user-10', 'tenant-10');
		await addWorkspace('user-10', 'tenant-10-shop', 'Shop');
		await addWorkspace('user-10', 'tenant-10-paused', 'Paused');
		const stores = { routing: routing(), analytics: { 'analytics-1': env.OAUTH_ANALYTICS } };
		await suspendTenant(
			identity(),
			stores,
			{ kind: 'operator', id: 'test-operator' },
			{
				tenantId: 'tenant-10-paused',
				reason: 'spam',
				now: Date.now()
			}
		);
		const flow = await startFlow('user-10', { workspace: 'tenant-10-shop' });
		const session = await identity()
			.prepare('SELECT id FROM session WHERE userId = ?')
			.bind('user-10')
			.first<{ id: string }>();
		await setActiveWorkspace(identity(), {
			userId: 'user-10',
			sessionId: session?.id ?? '',
			tenantId: 'tenant-10-shop',
			now: Date.now()
		});
		const location = (await authorize(flow)).headers.get('location') ?? '';
		const oauthQuery = location.slice(location.indexOf('?') + 1);
		const details = await oauth().fetch(
			new Request(`${origin}/oauth2/consent/request?${oauthQuery}`, {
				headers: { cookie: flow.cookie }
			})
		);
		// A suspended workspace is not offered; the session's active one is selected.
		expect(await details.json()).toMatchObject({
			workspaces: [
				{ id: 'tenant-10', name: 'Workspace' },
				{ id: 'tenant-10-shop', name: 'Shop' }
			],
			selectedWorkspaceId: 'tenant-10-shop'
		});
		const decide = (workspace?: string) =>
			oauth().fetch(
				new Request(`${origin}/oauth2/consent`, {
					method: 'POST',
					headers: { cookie: flow.cookie, origin, 'content-type': 'application/json' },
					body: JSON.stringify({ accept: true, oauth_query: oauthQuery, workspace_id: workspace })
				})
			);
		expect((await decide()).status).toBe(400);
		// Another person's workspace.
		expect((await decide('tenant-2')).status).toBe(409);
		expect((await decide('tenant-10-paused')).status).toBe(403);
		const chosen = await approve({ ...flow, workspace: 'tenant-10' });
		const response = await exchange(flow, chosen.searchParams.get('code') ?? '');
		expect(response.status).toBe(200);
		const tokens = (await response.json()) as Tokens;
		const stored = await identity()
			.prepare('SELECT DISTINCT referenceId FROM oauthAccessToken WHERE clientId = ?')
			.bind(flow.clientId)
			.all<{ referenceId: string }>();
		expect(stored.results).toEqual([{ referenceId: 'tenant-10' }]);
		expect((await call(tokens.access_token, 'get_usage')).status).toBe(200);
		// Leaving the other workspaces does not end a grant for this one.
		await identity()
			.prepare(
				"DELETE FROM tenant_memberships WHERE user_id = 'user-10' AND tenant_id != 'tenant-10'"
			)
			.run();
		expect((await call(tokens.access_token, 'get_usage')).status).toBe(200);
	});

	it('shows consent again for an app that was approved before', async () => {
		const first = await connect('user-1');
		const again = await startFlow('user-1', { clientId: first.clientId, cookie: first.cookie });
		const location = (await authorize(again)).headers.get('location') ?? '';
		expect(location.startsWith('/app/oauth/consent?')).toBe(true);
	});

	it('returns access_denied when the person declines', async () => {
		const callback = await approve(await startFlow('user-1'), false);
		expect(callback.searchParams.get('error')).toBe('access_denied');
		expect(callback.searchParams.get('iss')).toBe(origin);
		expect(callback.searchParams.has('code')).toBe(false);
	});

	it('refuses a consent from another origin or without a session', async () => {
		const flow = await startFlow('user-1');
		const location = (await authorize(flow)).headers.get('location') ?? '';
		const body = JSON.stringify({
			accept: true,
			oauth_query: location.slice(location.indexOf('?') + 1)
		});
		const foreign = await oauth().fetch(
			new Request(`${origin}/oauth2/consent`, {
				method: 'POST',
				headers: {
					cookie: flow.cookie,
					origin: 'https://evil.example',
					'content-type': 'application/json'
				},
				body
			})
		);
		expect(foreign.status).toBe(403);
		const anonymous = await oauth().fetch(
			new Request(`${origin}/oauth2/consent`, {
				method: 'POST',
				headers: { origin, 'content-type': 'application/json' },
				body
			})
		);
		expect(anonymous.status).toBe(401);
	});

	it('refuses a tampered consent query', async () => {
		const flow = await startFlow('user-1');
		const location = (await authorize(flow)).headers.get('location') ?? '';
		const tampered = location
			.slice(location.indexOf('?') + 1)
			.replace('links%3Aread', 'links%3Awrite');
		const details = await oauth().fetch(
			new Request(`${origin}/oauth2/consent/request?${tampered}`, {
				headers: { cookie: flow.cookie }
			})
		);
		expect(details.status).toBe(400);
		const consent = await oauth().fetch(
			new Request(`${origin}/oauth2/consent`, {
				method: 'POST',
				headers: { cookie: flow.cookie, origin, 'content-type': 'application/json' },
				body: JSON.stringify({ accept: true, oauth_query: tampered })
			})
		);
		expect(consent.status).toBe(400);
	});

	it('lets exactly one of 10 concurrent exchanges redeem a code, then refuses replay', async () => {
		const flow = await startFlow('user-2');
		const code = (await approve(flow)).searchParams.get('code') ?? '';
		const responses = await Promise.all(Array.from({ length: 10 }, () => exchange(flow, code)));
		expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
		expect((await exchange(flow, code)).status).toBe(400);
	});

	it('refuses a wrong verifier, a wrong redirect URI, and another resource at the token endpoint', async () => {
		const changes: Record<string, string>[] = [
			{ code_verifier: 'x'.repeat(64) },
			{ redirect_uri: 'https://client.example/other' },
			{ resource: 'https://api.example/other' }
		];
		for (const extra of changes) {
			const flow = await startFlow('user-2');
			const code = (await approve(flow)).searchParams.get('code') ?? '';
			const response = await exchange(flow, code, extra);
			expect(response.status).toBeGreaterThanOrEqual(400);
			expect(response.status).toBeLessThan(500);
		}
	});

	it('refuses plain PKCE, a missing challenge, another resource, and an unregistered redirect', async () => {
		const cases: Array<(query: URLSearchParams) => void> = [
			(query) => query.set('code_challenge_method', 'plain'),
			(query) => {
				query.delete('code_challenge');
				query.delete('code_challenge_method');
			},
			(query) => query.set('resource', 'https://api.example/other')
		];
		for (const change of cases) {
			const flow = await startFlow('user-2');
			change(flow.query);
			const location = new URL((await authorize(flow)).headers.get('location') ?? '', origin);
			expect(location.origin + location.pathname).toBe(redirectUri);
			expect(location.searchParams.get('error')).toMatch(/invalid_request|invalid_target/);
			expect(location.searchParams.has('code')).toBe(false);
		}
		const flow = await startFlow('user-2', { redirect: 'https://evil.example/callback' });
		const location = new URL((await authorize(flow)).headers.get('location') ?? '', origin);
		expect(location.origin).toBe(origin);
		expect(location.searchParams.get('error')).toBe('invalid_redirect');
	});

	it('rotates refresh tokens; 10 concurrent refreshes yield one new token', async () => {
		const { clientId, tokens } = await connect('user-2');
		const refresh = () =>
			oauth().fetch(
				form({
					grant_type: 'refresh_token',
					refresh_token: tokens.refresh_token,
					client_id: clientId
				})
			);
		const responses = await Promise.all(Array.from({ length: 10 }, refresh));
		const issued = new Set<string>();
		for (const response of responses)
			if (response.status === 200) issued.add(((await response.json()) as Tokens).refresh_token);
			else expect(response.status).toBe(400);
		expect(issued.size).toBe(1);
		const live = await identity()
			.prepare('SELECT COUNT(*) AS n FROM oauthRefreshToken WHERE clientId = ? AND revoked IS NULL')
			.bind(clientId)
			.first<{ n: number }>();
		expect(live?.n).toBe(1);
	});

	it('revokes the whole family when a rotated refresh token is used after the retry window', async () => {
		const { clientId, tokens } = await connect('user-2');
		const first = await oauth().fetch(
			form({
				grant_type: 'refresh_token',
				refresh_token: tokens.refresh_token,
				client_id: clientId
			})
		);
		const rotated = (await first.json()) as Tokens;
		await identity()
			.prepare('UPDATE oauthRefreshToken SET rotationReplayExpiresAt = 0 WHERE clientId = ?')
			.bind(clientId)
			.run();
		const replay = await oauth().fetch(
			form({
				grant_type: 'refresh_token',
				refresh_token: tokens.refresh_token,
				client_id: clientId
			})
		);
		expect(replay.status).toBe(400);
		expect(await replay.json()).toMatchObject({ error: 'invalid_grant' });
		const newer = await oauth().fetch(
			form({
				grant_type: 'refresh_token',
				refresh_token: rotated.refresh_token,
				client_id: clientId
			})
		);
		expect(newer.status).toBe(400);
		expect((await call(rotated.access_token, 'get_usage')).status).toBe(401);
	});

	it('discovers a client from its metadata document and refuses a mismatched or private one', async () => {
		const flow = await startFlow('user-3', {
			clientId: cimdClientId,
			redirect: 'https://assistant.example/callback'
		});
		const callback = await approve(flow);
		expect(fetched).toContain(cimdClientId);
		const response = await exchange(flow, callback.searchParams.get('code') ?? '');
		expect(response.status).toBe(200);

		for (const clientId of [
			'https://mismatch.example/client.json',
			'https://127.0.0.1/client.json',
			'https://10.0.0.1/client.json',
			'https://localhost/client.json'
		]) {
			const before = fetched.length;
			const bad = await startFlow('user-3', {
				clientId,
				redirect: 'https://mismatch.example/callback'
			});
			const location = new URL((await authorize(bad)).headers.get('location') ?? '', origin);
			expect(location.origin).toBe(origin);
			expect(location.searchParams.has('code')).toBe(false);
			if (clientId !== 'https://mismatch.example/client.json') expect(fetched.length).toBe(before);
		}
	});

	it('fetches client metadata over HTTPS only and never follows a redirect', async () => {
		const seen: RequestInit[] = [];
		const guarded = createMetadataFetch(async (_input, init) => {
			seen.push(init ?? {});
			return new Response(null, { status: 302, headers: { location: 'https://10.0.0.1/' } });
		});
		await expect(guarded('http://client.example/client.json')).rejects.toThrow('HTTPS');
		expect(seen).toHaveLength(0);
		await expect(guarded('https://client.example/client.json')).rejects.toThrow('redirect');
		expect(seen[0].redirect).toBe('manual');
	});

	it('refuses skip_consent and ignores require_pkce in open registration', async () => {
		const attempt = (field: Record<string, unknown>) =>
			oauth().fetch(
				new Request(`${origin}/oauth2/register`, {
					method: 'POST',
					headers: { 'content-type': 'application/json', 'x-test-source': crypto.randomUUID() },
					body: JSON.stringify({
						redirect_uris: [redirectUri],
						token_endpoint_auth_method: 'none',
						client_name: 'Sneaky',
						...field
					})
				})
			);
		expect((await attempt({ skip_consent: true })).status).toBe(400);
		const relaxed = await attempt({ require_pkce: false });
		expect(relaxed.status).toBe(201);
		const clientId = String(((await relaxed.json()) as Record<string, unknown>).client_id);
		const flow = await startFlow('user-1', { clientId });
		flow.query.delete('code_challenge');
		flow.query.delete('code_challenge_method');
		const location = new URL((await authorize(flow)).headers.get('location') ?? '', origin);
		expect(location.searchParams.get('error')).toBe('invalid_request');
		expect(location.searchParams.has('code')).toBe(false);
	});

	it('limits open registration per source', async () => {
		const source = 'source-flood';
		for (let n = 0; n < registrationsPerSourceHour; n += 1) await register(source);
		const refused = await oauth().fetch(
			new Request(`${origin}/oauth2/register`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'x-test-source': source },
				body: JSON.stringify({ redirect_uris: [redirectUri], token_endpoint_auth_method: 'none' })
			})
		);
		expect(refused.status).toBe(429);
		expect(refused.headers.get('retry-after')).not.toBeNull();
	});

	it('revokes a refresh token through RFC 7009', async () => {
		const { clientId, tokens } = await connect('user-3');
		const revoked = await oauth().fetch(
			new Request(`${origin}/oauth2/revoke`, {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({
					token: tokens.refresh_token,
					token_type_hint: 'refresh_token',
					client_id: clientId
				})
			})
		);
		expect(revoked.status).toBe(200);
		const refresh = await oauth().fetch(
			form({
				grant_type: 'refresh_token',
				refresh_token: tokens.refresh_token,
				client_id: clientId
			})
		);
		expect(refresh.status).toBe(400);
	});
});

describe('known assistants', () => {
	it('names an assistant only when every redirect URI is its own', () => {
		expect(knownAssistant(['https://claude.ai/api/mcp/auth_callback'])).toBe('claude');
		expect(knownAssistant(['https://chatgpt.com/connector_platform_oauth_redirect'])).toBe(
			'chatgpt'
		);
		expect(knownAssistant(['https://chatgpt.com/connector/oauth/abc123'])).toBe('chatgpt');
		expect(knownAssistant(['cursor://anysphere.cursor-retrieval/oauth/user-mcp/callback'])).toBe(
			'cursor'
		);
		for (const uris of [
			[],
			// An app may call itself Claude; a second redirect URI could receive the code.
			['https://claude.ai/api/mcp/auth_callback', 'https://attacker.example/callback'],
			['https://claude.ai/api/mcp/auth_callback', 'https://chatgpt.com/connector/oauth/x'],
			// Loopback redirects belong to whatever local program holds the port.
			['http://localhost:3118/callback'],
			['http://127.0.0.1/callback'],
			['https://claude.ai.attacker.example/api/mcp/auth_callback'],
			['https://claude.ai/api/mcp/auth_callback/extra'],
			['http://chatgpt.com/connector_platform_oauth_redirect'],
			['https://chatgpt.com/other'],
			['not a url']
		])
			expect(knownAssistant(uris), JSON.stringify(uris)).toBeNull();
	});
});

describe('connected apps API', () => {
	it('lists and revokes apps in the session workspace only', async () => {
		const { clientId, tokens } = await connect('user-3');
		const session = (userId: string): ApiPrincipal => ({
			kind: 'session',
			userId,
			sessionId: 'session-test',
			signedInAt: new Date().toISOString()
		});
		const list = await api(session('user-3')).fetch(new Request(`${origin}/v1/connected-apps`));
		const page = (await list.json()) as { apps: Record<string, unknown>[] };
		expect(page.apps.find((app) => app.clientId === clientId)).toMatchObject({
			name: 'Test client',
			assistant: null,
			uri: null,
			scopes: ['links:read', 'links:write', 'analytics:read', 'usage:read'],
			lastActiveAt: expect.any(String)
		});
		const others = await api(session('user-4')).fetch(new Request(`${origin}/v1/connected-apps`));
		expect(JSON.stringify(await others.json())).not.toContain(clientId);
		const path = `${origin}/v1/connected-apps/${encodeURIComponent(clientId)}`;
		const foreign = await api(session('user-4')).fetch(
			new Request(path, { method: 'DELETE', headers: { origin } })
		);
		expect(foreign.status).toBe(404);
		const fromApp = await api({
			kind: 'oauth',
			userId: 'user-3',
			tenantId: 'tenant-3',
			scopes: ['links:read'],
			clientId
		}).fetch(new Request(path, { method: 'DELETE' }));
		expect(fromApp.status).toBe(403);
		const revoked = await api(session('user-3')).fetch(
			new Request(path, { method: 'DELETE', headers: { origin } })
		);
		expect(revoked.status).toBe(204);
		expect((await call(tokens.access_token, 'get_usage')).status).toBe(401);
	});
});

describe('MCP endpoint', () => {
	it('challenges a request without a valid token and points to the resource metadata', async () => {
		for (const token of [null, 'flo_at_not-a-token', 'flr_api_token']) {
			const response = await mcp()(rpc(token, 'tools/list'));
			expect(response.status).toBe(401);
			expect(response.headers.get('www-authenticate')).toBe(
				`Bearer resource_metadata="https://api.example/.well-known/oauth-protected-resource/mcp", scope="links:read links:write analytics:read domains:read usage:read"${token ? ', error="invalid_token"' : ''}`
			);
		}
		expect((await mcp()(new Request(resource))).status).toBe(405);
	});

	it('describes itself in a server card that names every tool', async () => {
		const { tokens } = await connect('user-4');
		const listed = (await (await mcp()(rpc(tokens.access_token, 'tools/list'))).json()) as {
			result: { tools: { name: string }[] };
		};
		const card = mcpServerCard(resource);
		expect(card.transport).toEqual({ type: 'streamable-http', endpoint: resource });
		expect(card.tools).toEqual(listed.result.tools.map((tool) => tool.name));
	});

	it('refuses a foreign Origin', async () => {
		const { tokens } = await connect('user-4');
		const request = rpc(tokens.access_token, 'tools/list');
		const foreign = new Request(request, { headers: new Headers(request.headers) });
		foreign.headers.set('origin', 'https://evil.example');
		expect((await mcp()(foreign)).status).toBe(403);
	});

	it('lists the tools with annotations on the 2026-07-28 and 2025-11-25 protocols', async () => {
		const { tokens } = await connect('user-4');
		const modern = await mcp()(rpc(tokens.access_token, 'tools/list'));
		expect(modern.status).toBe(200);
		const listed = (await modern.json()) as {
			result: { tools: (Record<string, unknown> & { annotations: { readOnlyHint: boolean } })[] };
		};
		const names = listed.result.tools.map((tool) => tool.name);
		expect(names).toEqual([
			'list_links',
			'get_link',
			'get_link_qr',
			'get_link_analytics',
			'get_usage',
			'list_domains',
			'export_links',
			'create_link',
			'import_links',
			'update_link',
			'disable_link',
			'enable_link'
		]);
		for (const tool of listed.result.tools) {
			expect(tool.title).toEqual(expect.any(String));
			expect(tool.outputSchema).toEqual(expect.any(Object));
			// A strict schema makes a client with a cached tool list refuse a new result field.
			expect(JSON.stringify(tool.outputSchema)).not.toContain('"additionalProperties":false');
			// The Claude directory reads the listing name from annotations.title and needs one
			// of the two hints set on every tool.
			expect(tool.annotations).toMatchObject({
				title: tool.title,
				readOnlyHint: expect.any(Boolean),
				destructiveHint: !tool.annotations.readOnlyHint,
				openWorldHint: expect.any(Boolean)
			});
		}

		const legacy = (body: unknown) =>
			mcp()(
				new Request(resource, {
					method: 'POST',
					headers: {
						authorization: `Bearer ${tokens.access_token}`,
						'content-type': 'application/json',
						accept: 'application/json, text/event-stream'
					},
					body: JSON.stringify(body)
				})
			);
		const initialized = await legacy({
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: {
				protocolVersion: '2025-11-25',
				capabilities: {},
				clientInfo: { name: 'legacy', version: '1.0.0' }
			}
		});
		expect(initialized.status).toBe(200);
		const text = await initialized.text();
		expect(text).toContain('2025-11-25');
		const tools = await legacy({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
		expect(tools.status).toBe(200);
		expect(await tools.text()).toContain('create_link');
	});

	it('creates, finds, edits, turns off, and measures links in the token workspace only', async () => {
		const { tokens } = await connect('user-4');
		const token = tokens.access_token;
		productEvents.length = 0;
		const created = await call(token, 'create_link', {
			destination: 'https://example.com/a',
			slug: 'mcp-first',
			title: 'First'
		});
		expect(created.status).toBe(200);
		expect(productEvents).toEqual([
			expect.objectContaining({ type: 'mcp_tool_called', userId: 'user-4', tool: 'create_link' })
		]);
		const link = created.body.result?.structuredContent?.link as Record<string, unknown>;
		expect(link).toMatchObject({
			slug: 'mcp-first',
			destination: 'https://example.com/a',
			enabled: true
		});
		expect(link).not.toHaveProperty('domainId');
		const again = await call(token, 'create_link', {
			destination: 'https://example.com/a',
			slug: 'mcp-first',
			title: 'First'
		});
		expect(again.body.result?.structuredContent).toMatchObject({
			replayed: true,
			link: { id: link.id }
		});

		const bySlug = await call(token, 'get_link', { link: 'mcp-first' });
		expect(bySlug.body.result?.structuredContent).toMatchObject({ link: { id: link.id } });
		const listed = await call(token, 'list_links', { search: 'mcp-first' });
		expect(listed.body.result?.structuredContent).toMatchObject({
			links: [{ id: link.id, clicksLast30Days: 0 }]
		});
		const updated = await call(token, 'update_link', {
			link: 'mcp-first',
			destination: 'https://example.com/b',
			title: null
		});
		expect(updated.body.result?.structuredContent).toMatchObject({
			link: { destination: 'https://example.com/b', title: null }
		});
		const off = await call(token, 'disable_link', { link: String(link.id) });
		expect(off.body.result?.structuredContent).toMatchObject({ link: { enabled: false } });
		const on = await call(token, 'enable_link', { link: 'mcp-first' });
		expect(on.body.result?.structuredContent).toMatchObject({ link: { enabled: true } });
		const analytics = await call(token, 'get_link_analytics', { link: 'mcp-first' });
		expect(analytics.body.result?.structuredContent).toMatchObject({
			analytics: { linkId: link.id, total: 0 }
		});
		const usage = await call(token, 'get_usage');
		expect(usage.body.result?.structuredContent).toMatchObject({
			usage: { clicks: 0, clickLimit: 5000 }
		});

		const app = await call(token, 'create_link', {
			destination: 'https://example.com/app?q=1',
			slug: 'mcp-app',
			iosDestination: 'myapp://item/1',
			utm: { source: 'assistant', campaign: 'launch' }
		});
		expect(app.body.result?.structuredContent).toMatchObject({
			link: {
				destination: 'https://example.com/app?q=1&utm_source=assistant&utm_campaign=launch',
				iosDestination: 'myapp://item/1',
				androidDestination: null
			}
		});
		const tagged = await call(token, 'update_link', {
			link: 'mcp-app',
			utm: { source: '', medium: 'chat' },
			iosDestination: null,
			androidDestination: 'https://example.com/android'
		});
		expect(tagged.body.result?.structuredContent).toMatchObject({
			link: {
				destination: 'https://example.com/app?q=1&utm_campaign=launch&utm_medium=chat',
				iosDestination: null,
				androidDestination: 'https://example.com/android'
			}
		});
		const badUtm = await call(token, 'create_link', {
			destination: 'example.com',
			utm: { source: 'x' }
		});
		expect(badUtm.body.result?.isError).toBe(true);
		expect(badUtm.body.result?.content[0].text).toContain('INVALID_INPUT');
		const badApp = await call(token, 'create_link', {
			destination: 'https://example.com/x',
			iosDestination: 'javascript://alert(1)'
		});
		expect(badApp.body.result?.content[0].text).toContain('iosDestination');

		const invalid = await call(token, 'create_link', { destination: 'ftp://example.com' });
		expect(invalid.status).toBe(200);
		expect(invalid.body.result?.isError).toBe(true);
		expect(invalid.body.result?.content[0].text).toContain('INVALID_INPUT');

		const other = await connect('user-5');
		const missing = await call(other.tokens.access_token, 'get_link', { link: String(link.id) });
		expect(missing.body.result?.isError).toBe(true);
		expect(missing.body.result?.content[0].text).toContain('NOT_FOUND');
		const otherSlug = await call(other.tokens.access_token, 'get_link', { link: 'mcp-first' });
		expect(otherSlug.body.result?.isError).toBe(true);
	});

	it('lists the workspace domains and creates links on an active one by hostname', async () => {
		const { tokens } = await connect(
			'user-8',
			'links:read links:write domains:read offline_access'
		);
		const token = tokens.access_token;
		const listed = await call(token, 'list_domains');
		expect(listed.status).toBe(200);
		const page = listed.body.result?.structuredContent as {
			domains: Record<string, unknown>[];
			used: number;
			limit: number;
		};
		expect(page).toEqual({
			domains: [
				{
					hostname: 'short.example',
					state: 'active',
					kind: 'platform',
					isDefault: true,
					setup: null,
					records: [],
					error: null
				},
				{
					hostname: 'go.brand.com',
					state: 'active',
					kind: 'workspace',
					isDefault: false,
					setup: 'dns',
					records: [{ type: 'CNAME', name: 'go.brand.com', value: 'customers.short.example' }],
					error: null
				},
				{
					hostname: 'links.shop.com',
					state: 'pending',
					kind: 'workspace',
					isDefault: false,
					setup: 'dns',
					records: [{ type: 'CNAME', name: 'links.shop.com', value: 'customers.short.example' }],
					error: null
				}
			],
			used: 2,
			limit: 1
		});

		const input = { destination: 'https://example.com/brand', slug: 'mcp-brand' };
		const created = await call(token, 'create_link', { ...input, domain: 'GO.Brand.com.' });
		expect(created.body.result?.structuredContent).toMatchObject({
			replayed: false,
			link: { hostname: 'go.brand.com', shortUrl: 'https://go.brand.com/mcp-brand' }
		});
		const again = await call(token, 'create_link', { ...input, domain: 'go.brand.com' });
		expect(again.body.result?.structuredContent).toMatchObject({ replayed: true });
		// The same input without a domain is another request, on the default domain.
		const plain = await call(token, 'create_link', input);
		expect(plain.body.result?.structuredContent).toMatchObject({
			replayed: false,
			link: { hostname: 'short.example' }
		});
		const shared = await call(token, 'create_link', {
			destination: 'https://example.com/shared',
			domain: 'short.example'
		});
		expect(shared.body.result?.structuredContent).toMatchObject({
			link: { hostname: 'short.example' }
		});

		for (const [domain, code] of [
			['links.shop.com', 'DOMAIN_UNAVAILABLE'],
			['go.other.com', 'NOT_FOUND'],
			['go.unknown.com', 'NOT_FOUND']
		]) {
			const refused = await call(token, 'create_link', {
				destination: 'https://example.com/refused',
				domain
			});
			expect(refused.body.result?.isError, domain).toBe(true);
			expect(JSON.parse(refused.body.result?.content[0].text ?? '{}')).toMatchObject({
				error: { code, field: 'domain' }
			});
		}
	});

	it('previews an import, then creates its links once, with links:write', async () => {
		await addTenant('user-11', 'tenant-11');
		const { tokens } = await connect('user-11');
		const token = tokens.access_token;
		const items = [
			{ destination: 'https://example.com/i1', slug: 'mcp-import-one', utm: { source: 'chat' } },
			{ destination: 'https://example.com/i2', iosDestination: 'myapp://two' },
			{ destination: 'ftp://example.com/bad' }
		];
		const listed = async () =>
			(await call(token, 'list_links')).body.result?.structuredContent?.links as unknown[];

		productEvents.length = 0;
		const preview = await call(token, 'import_links', { dryRun: true, items });
		expect(preview.status).toBe(200);
		expect(preview.body.result?.structuredContent).toEqual({
			dryRun: true,
			results: [
				{ index: 0, status: 'ready' },
				{ index: 1, status: 'ready' },
				{
					index: 2,
					status: 'failed',
					error: expect.objectContaining({ code: 'INVALID_INPUT', field: 'destination' })
				}
			],
			summary: { ready: 2, failed: 1 }
		});
		expect(preview.body.result?.content[0].text).toBe(
			'Dry run: 2 of 3 items are ready and 1 would fail. Nothing was created.'
		);
		expect(productEvents).toEqual([
			expect.objectContaining({ type: 'mcp_tool_called', userId: 'user-11', tool: 'import_links' })
		]);
		expect(await listed()).toEqual([]);

		const run = await call(token, 'import_links', { dryRun: false, items });
		const result = run.body.result?.structuredContent as {
			results: { status: string; link?: Record<string, unknown> }[];
			summary: unknown;
		};
		expect(result.summary).toEqual({ created: 2, failed: 1 });
		expect(result.results.map((item) => item.status)).toEqual(['created', 'created', 'failed']);
		expect(result.results[0].link).toMatchObject({
			slug: 'mcp-import-one',
			destination: 'https://example.com/i1?utm_source=chat'
		});
		expect(result.results[0].link).not.toHaveProperty('domainId');
		expect(result.results[1].link).toMatchObject({ iosDestination: 'myapp://two' });
		expect(run.body.result?.content[0].text).toBe('Created 2 of 3 links; 1 failed.');
		expect(await listed()).toHaveLength(2);

		// A retried call replays each item and creates nothing twice.
		const again = await call(token, 'import_links', { dryRun: false, items });
		expect(again.body.result?.structuredContent).toEqual(result);
		expect(await listed()).toHaveLength(2);

		const tooMany = await call(token, 'import_links', {
			dryRun: false,
			items: [1, 2, 3, 4].map((n) => ({ destination: `https://example.com/many/${n}` }))
		});
		expect(tooMany.body.result?.isError).toBe(true);
		expect(await listed()).toHaveLength(2);

		const readOnly = await connect('user-11', 'links:read offline_access');
		const refused = await call(readOnly.tokens.access_token, 'import_links', {
			dryRun: true,
			items: [{ destination: 'https://example.com/read-only' }]
		});
		expect(refused.status).toBe(403);
		expect(refused.headers.get('www-authenticate')).toBe(
			'Bearer error="insufficient_scope", scope="links:read links:write", resource_metadata="https://api.example/.well-known/oauth-protected-resource/mcp"'
		);
	});

	it('imports links on an active workspace domain by hostname', async () => {
		const { tokens } = await connect(
			'user-8',
			'links:read links:write domains:read offline_access'
		);
		const token = tokens.access_token;
		const created = await call(token, 'import_links', {
			dryRun: false,
			items: [
				{ destination: 'https://example.com/import-brand', domain: 'GO.Brand.com.' },
				{ destination: 'https://example.com/import-default' }
			]
		});
		expect(created.body.result?.structuredContent).toMatchObject({
			results: [
				{ status: 'created', link: { hostname: 'go.brand.com' } },
				{ status: 'created', link: { hostname: 'short.example' } }
			]
		});
		const refused = await call(token, 'import_links', {
			dryRun: true,
			items: [
				{ destination: 'https://example.com/import-ok' },
				{ destination: 'https://example.com/import-pending', domain: 'links.shop.com' }
			]
		});
		expect(refused.body.result?.isError).toBe(true);
		expect(JSON.parse(refused.body.result?.content[0].text ?? '{}')).toMatchObject({
			error: { code: 'DOMAIN_UNAVAILABLE', field: 'items.1.domain' }
		});
	});

	it('keeps an import of the most items on a workspace domain within 50 D1 statements', async () => {
		const counter = { queries: 0 };
		const countedIdentity = counting(identity(), counter);
		const countedRouting = counting(routing(), counter);
		const counted = createMcpEndpoint({
			identity: countedIdentity,
			resource,
			issuer: origin,
			allowedOrigins: [origin],
			api: (principal) =>
				createApi({
					identity: countedIdentity,
					routing: countedRouting,
					analytics: { 'analytics-1': env.OAUTH_ANALYTICS },
					appOrigin: origin,
					domains: { provider: domainProvider, reservedHostnames: ['short.example'] },
					authenticate: async () => principal
				}),
			events
		});
		const { tokens } = await connect(
			'user-8',
			'links:read links:write domains:read offline_access'
		);
		const items = Array.from({ length: mcpImportItemsPerCall }, (_, index) => ({
			destination: `https://example.com/budget/${index}`,
			slug: `mcp-budget-${index}`,
			domain: 'go.brand.com'
		}));
		const measure = async (dryRun: boolean) => {
			counter.queries = 0;
			const response = await counted(
				rpc(tokens.access_token, 'tools/call', {
					name: 'import_links',
					arguments: { dryRun, items }
				})
			);
			expect(response.status).toBe(200);
			const body = (await response.json()) as { result: { structuredContent: unknown } };
			return { queries: counter.queries, result: body.result.structuredContent };
		};
		const preview = await measure(true);
		const created = await measure(false);
		const replayed = await measure(false);
		expect(preview.result).toMatchObject({ summary: { ready: items.length, failed: 0 } });
		expect(created.result).toMatchObject({ summary: { created: items.length, failed: 0 } });
		expect(replayed.result).toEqual(created.result);
		// Measured with 3 items: 12 (dry run), 37 (created), 42 (replayed).
		for (const run of [preview, created, replayed]) expect(run.queries).toBeLessThan(50);
	});

	it('exports every link with an item that import_links takes, page by page', async () => {
		await addTenant('user-12', 'tenant-12');
		await addTenant('user-13', 'tenant-13');
		const { tokens } = await connect('user-12');
		const token = tokens.access_token;
		const inputs = [
			{ destination: 'https://example.com/export/1', slug: 'mcp-export-one', title: 'One' },
			{ destination: 'https://example.com/export/2', slug: 'mcp-export-two', title: 'Two' },
			{
				destination: 'https://example.com/export/3',
				slug: 'mcp-export-three',
				iosDestination: 'myapp://three',
				androidDestination: 'https://example.com/android/3'
			}
		];
		const ids: string[] = [];
		for (const [index, input] of inputs.entries()) {
			const created = await call(token, 'create_link', input);
			const link = created.body.result?.structuredContent?.link as { id: string };
			// Distinct creation times make the newest-first order certain.
			await routing()
				.prepare('UPDATE links SET created_at = ? WHERE id = ?')
				.bind(1000 + index, link.id)
				.run();
			ids.push(link.id);
		}
		await setLinkBlock(routing(), ids[0], { reason: 'spam', now: Date.now() });
		await call(token, 'disable_link', { link: ids[1] });

		const { page } = await exportPage(token);
		expect(page.nextCursor).toBeNull();
		expect(page.links.map((link) => link.id)).toEqual([ids[2], ids[1], ids[0]]);
		expect(page.links.map((link) => link.status)).toEqual(['active', 'disabled', 'blocked']);
		expect(page.links.map((link) => link.item)).toEqual([
			{ ...inputs[2], domain: 'short.example' },
			{ ...inputs[1], domain: 'short.example' },
			{ ...inputs[0], domain: 'short.example' }
		]);
		expect(JSON.stringify(page.links)).not.toContain('null');
		expect(page.links[0]).not.toHaveProperty('domainId');

		const first = (await exportPage(token, { limit: 2 })).page;
		expect(first.links).toHaveLength(2);
		expect(first.nextCursor).toEqual(expect.any(String));
		const second = (await exportPage(token, { limit: 2, cursor: first.nextCursor })).page;
		expect(second.nextCursor).toBeNull();
		expect([...first.links, ...second.links].map((link) => link.id)).toEqual([
			ids[2],
			ids[1],
			ids[0]
		]);

		// Slugs stay reserved on short.example, so the copy goes to another workspace's domain.
		await routing().batch([
			routing().prepare(
				"INSERT INTO domain_namespaces (id, hostname, created_at) VALUES ('dom-export', 'go.export.com', 0)"
			),
			routing().prepare(
				"INSERT INTO domains (id, tenant_id, state, is_default, created_at, updated_at, claimed_at, activated_at) VALUES ('dom-export', 'tenant-13', 'active', 0, 1, 1, 1, 1)"
			)
		]);
		const other = await connect('user-13', 'links:read links:write domains:read offline_access');
		const items = page.links.map(({ item }) => ({ ...item, domain: 'go.export.com' }));
		const imported = await call(other.tokens.access_token, 'import_links', {
			dryRun: false,
			items
		});
		expect(imported.body.result?.structuredContent).toMatchObject({
			summary: { created: 3, failed: 0 }
		});
		const copies = (await exportPage(other.tokens.access_token)).page.links;
		const bySlug = (a: Record<string, unknown>, b: Record<string, unknown>) =>
			String(a.slug).localeCompare(String(b.slug));
		expect(copies.map(({ item }) => item).sort(bySlug)).toEqual([...items].sort(bySlug));
		// Status is not copied: imported links start on.
		expect(copies.map((link) => link.status)).toEqual(['active', 'active', 'active']);
	});

	it('needs links:read to export links and leaves analytics out', async () => {
		const analyticsOnly = await connect('user-12', 'analytics:read offline_access');
		const refused = await call(analyticsOnly.tokens.access_token, 'export_links');
		expect(refused.status).toBe(403);
		expect(refused.headers.get('www-authenticate')).toBe(
			'Bearer error="insufficient_scope", scope="links:read analytics:read", resource_metadata="https://api.example/.well-known/oauth-protected-resource/mcp"'
		);
		const reader = await connect('user-12', 'links:read offline_access');
		const { page, text } = await exportPage(reader.tokens.access_token);
		expect(page.links).toHaveLength(3);
		expect(text).not.toContain('clicksLast30Days');
	});

	it('halves an export page until it is within the byte cap and still reaches every link', async () => {
		// Inserts count links whose three destinations each have the given length.
		const addLarge = async (
			tenantId: string,
			count: number,
			length: number,
			title: string | null
		) => {
			const long = (prefix: string) => prefix + 'x'.repeat(length - prefix.length);
			await routing().batch(
				Array.from({ length: count }, (_, index) => {
					const slug = `${tenantId}-${index}-`.padEnd(64, 'x');
					return [
						routing()
							.prepare("INSERT INTO slug_reservations (domain_id, slug) VALUES ('dom-short', ?)")
							.bind(slug),
						routing()
							.prepare(
								"INSERT INTO links (id, tenant_id, domain_id, slug, destination, ios_destination, android_destination, title, status, created_at, updated_at) VALUES (?, ?, 'dom-short', ?, ?, ?, ?, ?, 'active', ?, ?)"
							)
							.bind(
								`${tenantId}-link-${index}`,
								tenantId,
								slug,
								long(`https://example.com/${index}/`),
								long(`myapp://${index}/`),
								long(`https://example.com/android/${index}/`),
								title,
								index,
								index
							)
					];
				}).flat()
			);
		};
		// Follows nextCursor to the end and checks that every page is within the cap.
		const walk = async (token: string, limit: number | undefined, count: number) => {
			const seen: string[] = [];
			let cursor: string | null = null;
			let calls = 0;
			do {
				const args: Record<string, unknown> = {
					...(limit ? { limit } : {}),
					...(cursor ? { cursor } : {})
				};
				const { page, text } = await exportPage(token, args);
				expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(mcpExportResultBytes);
				if (calls === 0) {
					expect(page.links.length).toBeLessThan(count);
					expect(page.nextCursor).toEqual(expect.any(String));
				}
				seen.push(...page.links.map((link) => link.id));
				cursor = page.nextCursor;
				calls += 1;
			} while (cursor && calls < count);
			return seen;
		};
		const newestFirst = (tenantId: string, count: number) =>
			Array.from({ length: count }, (_, index) => `${tenantId}-link-${count - 1 - index}`);

		await addTenant('user-14', 'tenant-14');
		await addLarge('tenant-14', 30, 4000, null);
		const { tokens } = await connect('user-14');
		expect(await walk(tokens.access_token, undefined, 30)).toEqual(newestFirst('tenant-14', 30));

		// The largest page: 100 links with every field at its longest.
		await addTenant('user-15', 'tenant-15');
		await addLarge('tenant-15', 100, 4096, 't'.repeat(200));
		const largest = await connect('user-15');
		expect(await walk(largest.tokens.access_token, 100, 100)).toEqual(
			newestFirst('tenant-15', 100)
		);
	});

	it('exports a page within 10 D1 statements', async () => {
		const counter = { queries: 0 };
		const countedIdentity = counting(identity(), counter);
		const countedRouting = counting(routing(), counter);
		const counted = createMcpEndpoint({
			identity: countedIdentity,
			resource,
			issuer: origin,
			allowedOrigins: [origin],
			api: (principal) =>
				createApi({
					identity: countedIdentity,
					routing: countedRouting,
					analytics: { 'analytics-1': env.OAUTH_ANALYTICS },
					appOrigin: origin,
					authenticate: async () => principal
				}),
			events
		});
		const { tokens } = await connect('user-12', 'links:read offline_access');
		const response = await counted(
			rpc(tokens.access_token, 'tools/call', { name: 'export_links', arguments: {} })
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { result: { structuredContent: ExportedPage } };
		expect(body.result.structuredContent.links).toHaveLength(3);
		expect(counter.queries).toBeLessThan(10);
	});

	it('returns a PNG QR code of the short URL', async () => {
		const { tokens } = await connect('user-8', 'links:read links:write offline_access');
		const token = tokens.access_token;
		await call(token, 'create_link', { destination: 'https://example.com/qr', slug: 'mcp-qr' });
		const result = await call(token, 'get_link_qr', { link: 'mcp-qr' });
		expect(result.status).toBe(200);
		const shortUrl = 'https://short.example/mcp-qr';
		expect(result.body.result?.structuredContent).toEqual({
			shortUrl,
			mimeType: 'image/png',
			size: 512
		});
		const [image, text] = result.body.result?.content ?? [];
		expect(image).toMatchObject({ type: 'image', mimeType: 'image/png' });
		const bytes = Uint8Array.from(atob(image.data ?? ''), (character) => character.charCodeAt(0));
		expect([...bytes.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		expect(bytes).toEqual(await qrPng(shortUrl, 512));
		expect(text).toMatchObject({ type: 'text' });
		expect(text.text).toContain(shortUrl);

		const missing = await call(token, 'get_link_qr', { link: 'mcp-none' });
		expect(missing.body.result?.isError).toBe(true);
		expect(missing.body.result?.content[0].text).toContain('NOT_FOUND');
	});

	it('needs domains:read to list domains or to create a link on one', async () => {
		const { tokens } = await connect('user-8', 'links:read links:write offline_access');
		const listed = await call(tokens.access_token, 'list_domains');
		expect(listed.status).toBe(403);
		expect(listed.headers.get('www-authenticate')).toBe(
			'Bearer error="insufficient_scope", scope="links:read links:write domains:read", resource_metadata="https://api.example/.well-known/oauth-protected-resource/mcp"'
		);
		const created = await call(tokens.access_token, 'create_link', {
			destination: 'https://example.com/scoped',
			domain: 'go.brand.com'
		});
		expect(created.body.result?.isError).toBe(true);
		expect(created.body.result?.content[0].text).toContain('INSUFFICIENT_SCOPE');
	});

	it('answers a write without the scope with 403 insufficient_scope naming the scopes it needs', async () => {
		const { tokens } = await connect('user-4', 'links:read offline_access');
		const read = await call(tokens.access_token, 'list_links');
		expect(read.status).toBe(200);
		const write = await call(tokens.access_token, 'create_link', {
			destination: 'https://example.com'
		});
		expect(write.status).toBe(403);
		expect(write.headers.get('www-authenticate')).toBe(
			'Bearer error="insufficient_scope", scope="links:read links:write", resource_metadata="https://api.example/.well-known/oauth-protected-resource/mcp"'
		);
		const analytics = await call(tokens.access_token, 'get_usage');
		expect(analytics.status).toBe(403);
	});

	it('refuses a token bound to another resource', async () => {
		const { clientId, tokens } = await connect('user-4');
		await identity()
			.prepare('UPDATE oauthAccessToken SET resources = ? WHERE clientId = ?')
			.bind(JSON.stringify(['https://api.example/other']), clientId)
			.run();
		expect((await call(tokens.access_token, 'get_usage')).status).toBe(401);
	});

	it('stops working on the next call after the app is revoked in settings', async () => {
		const { clientId, tokens } = await connect('user-6');
		expect((await call(tokens.access_token, 'get_usage')).status).toBe(200);
		expect(await deleteGrant(identity(), 'user-6', 'tenant-6', clientId)).toBe(true);
		expect((await call(tokens.access_token, 'get_usage')).status).toBe(401);
		const refresh = await oauth().fetch(
			form({
				grant_type: 'refresh_token',
				refresh_token: tokens.refresh_token,
				client_id: clientId
			})
		);
		expect(refresh.status).toBe(400);
		expect(await deleteGrant(identity(), 'user-6', 'tenant-6', clientId)).toBe(false);
		expect(await deleteGrant(identity(), 'user-5', 'tenant-5', clientId)).toBe(false);
	});

	it('refuses a token that a refresh racing the revocation wrote after it', async () => {
		const { clientId, tokens } = await connect('user-6');
		const row = await identity()
			.prepare('SELECT * FROM oauthAccessToken WHERE clientId = ?')
			.bind(clientId)
			.first<Record<string, unknown>>();
		expect(await deleteGrant(identity(), 'user-6', 'tenant-6', clientId)).toBe(true);
		// The rotation that was in flight writes its access token after the grant is gone.
		await identity()
			.prepare(
				'INSERT INTO oauthAccessToken (id, token, clientId, userId, referenceId, resources, expiresAt, createdAt, scopes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
			)
			.bind(
				'raced',
				row?.token,
				clientId,
				row?.userId,
				row?.referenceId,
				row?.resources,
				row?.expiresAt,
				Date.now() - 5000,
				row?.scopes
			)
			.run();
		expect((await call(tokens.access_token, 'get_usage')).status).toBe(401);
		// A later approval does not revive it.
		const later = await startFlow('user-6', { clientId });
		await approve(later);
		expect((await call(tokens.access_token, 'get_usage')).status).toBe(401);
	});

	it('stops working when the person leaves the workspace', async () => {
		const { tokens } = await connect('user-7');
		expect((await call(tokens.access_token, 'get_usage')).status).toBe(200);
		await identity().prepare("DELETE FROM tenant_memberships WHERE user_id = 'user-7'").run();
		expect((await call(tokens.access_token, 'get_usage')).status).toBe(401);
	});

	it('refuses calls while the workspace is suspended and works again after reinstatement', async () => {
		const { tokens } = await connect('user-9');
		const operator = { kind: 'operator', id: 'test-operator' } as const;
		const stores = { routing: routing(), analytics: { 'analytics-1': env.OAUTH_ANALYTICS } };
		await suspendTenant(identity(), stores, operator, {
			tenantId: 'tenant-9',
			reason: 'spam',
			now: Date.now()
		});
		expect((await call(tokens.access_token, 'get_usage')).status).toBe(403);
		// No new app can connect to a suspended workspace.
		const flow = await startFlow('user-9');
		const location = (await authorize(flow)).headers.get('location') ?? '';
		const consent = await oauth().fetch(
			new Request(`${origin}/oauth2/consent`, {
				method: 'POST',
				headers: { cookie: flow.cookie, origin, 'content-type': 'application/json' },
				body: JSON.stringify({
					accept: true,
					oauth_query: location.slice(location.indexOf('?') + 1),
					workspace_id: 'tenant-9'
				})
			})
		);
		expect(consent.status).toBe(403);
		await reinstateTenant(identity(), stores, operator, { tenantId: 'tenant-9', now: Date.now() });
		expect((await call(tokens.access_token, 'get_usage')).status).toBe(200);
	});

	it('limits calls per grant', async () => {
		const { tokens } = await connect('user-6');
		const statuses = await Promise.all(
			Array.from({ length: mcpCallsPerMinute + 5 }, () =>
				mcp()(rpc(tokens.access_token, 'tools/list')).then((response) => response.status)
			)
		);
		const limited = statuses.filter((status) => status === 429).length;
		expect(limited).toBeGreaterThanOrEqual(5);
		expect(statuses.filter((status) => status === 200)).toHaveLength(statuses.length - limited);
	});

	it('cleans up expired tokens and clients nobody approved', async () => {
		const unused = await register('source-cleanup');
		await identity()
			.prepare('UPDATE oauthClient SET createdAt = 0 WHERE clientId = ?')
			.bind(unused)
			.run();
		const kept = await connect('user-5');
		await identity()
			.prepare('UPDATE oauthClient SET createdAt = 0 WHERE clientId = ?')
			.bind(kept.clientId)
			.run();
		await deleteExpiredOAuthRecords(identity(), Date.now(), 1000);
		const remaining = await identity()
			.prepare('SELECT clientId FROM oauthClient WHERE clientId IN (?, ?)')
			.bind(unused, kept.clientId)
			.all<{ clientId: string }>();
		expect(remaining.results.map((row) => row.clientId)).toEqual([kept.clientId]);
	});
});
