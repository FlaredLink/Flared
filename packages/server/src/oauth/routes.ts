// SPDX-License-Identifier: AGPL-3.0-only
// The public routes of the OAuth authorization server on the application origin. Only these reach
// the provider library; its client, resource, consent-management, and introspection endpoints
// stay unreachable. Requests are rebuilt with a fixed set of headers.
import type { D1Database } from '@cloudflare/workers-types/index.ts';
import { verifyOAuthQueryParams } from '@better-auth/oauth-provider';
import { isTokenScope, type TokenScope } from '@flared/contracts/tokens';
import type { ConsentRequest } from '@flared/contracts/oauth';
import { countRegistration } from '@flared/data/oauth';
import { authResponseHeaders } from '../web/forward';
import { readPrincipal } from '../auth/session';
import { resolveTenant } from '../tenancy';
import { createOAuthServer, type OAuthServer, type OAuthServerConfig } from './provider';

export const registrationsPerSourceHour = 10;
export const registrationsPerHour = 500;
const maxBodyBytes = 16_384;

export interface OAuthRouteDependencies {
	db: D1Database;
	config: OAuthServerConfig;
	// A stable, non-reversible key for the request's network source, or null when it is unknown.
	// Open client registration is refused without one.
	sourceKey(request: Request): Promise<string | null>;
	now?: () => number;
}

export const oauthPaths = [
	'/.well-known/oauth-authorization-server',
	'/oauth2/authorize',
	'/oauth2/token',
	'/oauth2/register',
	'/oauth2/revoke',
	'/oauth2/consent',
	'/oauth2/consent/request'
] as const;

export function isOAuthPath(pathname: string): boolean {
	return (oauthPaths as readonly string[]).includes(pathname);
}

function respond(response: Response): Response {
	const headers = authResponseHeaders(response.headers);
	headers.delete('set-cookie');
	return new Response(response.body, { status: response.status, headers });
}

function oauthError(status: number, error: string, description: string, extra: HeadersInit = {}) {
	const headers = new Headers(extra);
	headers.set('content-type', 'application/json');
	return respond(
		new Response(JSON.stringify({ error, error_description: description }), { status, headers })
	);
}

function methodNotAllowed(allow: string): Response {
	return respond(new Response(null, { status: 405, headers: { allow } }));
}

async function readBody(request: Request): Promise<ArrayBuffer | null> {
	if (Number(request.headers.get('content-length') ?? '0') > maxBodyBytes) return null;
	const body = await request.arrayBuffer();
	return body.byteLength > maxBodyBytes ? null : body;
}

function copyHeaders(request: Request, names: readonly string[]): Headers {
	const headers = new Headers();
	for (const name of names) {
		const value = request.headers.get(name);
		if (value !== null) headers.set(name, value);
	}
	return headers;
}

// Metadata fields for endpoints and features these routes do not serve.
const hiddenMetadata = [
	'introspection_endpoint',
	'introspection_endpoint_auth_methods_supported',
	'introspection_endpoint_auth_signing_alg_values_supported',
	'dpop_signing_alg_values_supported'
];

// Every authorization shows the consent page, even when the app was approved before. A local
// app could otherwise use a remembered consent through a loopback redirect without the person
// seeing it. prompt=none and max_age are not supported, and are dropped with request objects.
const droppedAuthorizeParams = new Set([
	'prompt',
	'max_age',
	'request',
	'request_uri',
	'dpop_jkt',
	'claims'
]);
function authorizeQuery(url: URL): URLSearchParams {
	const query = new URLSearchParams();
	for (const [key, value] of url.searchParams)
		if (!droppedAuthorizeParams.has(key)) query.append(key, value);
	query.set('prompt', 'consent');
	return query;
}

function isLoopback(hostname: string): boolean {
	return (
		hostname === 'localhost' ||
		hostname === '[::1]' ||
		/^127(\.\d{1,3}){3}$/.test(hostname) ||
		hostname.endsWith('.localhost')
	);
}

function storedName(value: unknown, fallback: string): string {
	return typeof value === 'string' && value.trim() ? value.trim().slice(0, 100) : fallback;
}

function storedUri(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	try {
		const url = new URL(value);
		return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
	} catch {
		return null;
	}
}

export function createOAuthRoutes(dependencies: OAuthRouteDependencies) {
	const { db, config } = dependencies;
	const now = dependencies.now ?? Date.now;
	let server: OAuthServer | undefined;
	const auth = () => (server ??= createOAuthServer(db, config));
	const internal = (path: string, search = '') => `${config.origin}${path}${search}`;

	async function metadata(request: Request): Promise<Response> {
		if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed('GET, HEAD');
		const response = await auth().handler(
			new Request(internal('/.well-known/oauth-authorization-server'))
		);
		if (response.status !== 200) throw new Error('Authorization server metadata unavailable');
		const document = (await response.json()) as Record<string, unknown>;
		for (const key of hiddenMetadata) delete document[key];
		const headers = authResponseHeaders({
			'content-type': 'application/json',
			'access-control-allow-origin': '*'
		});
		headers.set('cache-control', 'public, max-age=3600');
		return new Response(request.method === 'HEAD' ? null : JSON.stringify(document), { headers });
	}

	async function authorize(request: Request, url: URL): Promise<Response> {
		if (request.method !== 'GET') return methodNotAllowed('GET');
		const response = await auth().handler(
			new Request(internal('/oauth2/authorize', `?${authorizeQuery(url)}`), {
				headers: copyHeaders(request, ['cookie']),
				redirect: 'manual'
			})
		);
		return respond(response);
	}

	// The token, registration, and revocation endpoints take form or JSON bodies from apps,
	// without cookies. A DPoP proof is not forwarded, so tokens are never sender-constrained.
	async function backChannel(request: Request, path: string): Promise<Response> {
		if (request.method !== 'POST') return methodNotAllowed('POST');
		const body = await readBody(request);
		if (!body) return oauthError(413, 'invalid_request', 'The request body is too large.');
		const response = await auth().handler(
			new Request(internal(path), {
				method: 'POST',
				headers: copyHeaders(request, ['content-type', 'authorization', 'accept']),
				body
			})
		);
		return respond(response);
	}

	async function register(request: Request): Promise<Response> {
		if (request.method !== 'POST') return methodNotAllowed('POST');
		const source = await dependencies.sourceKey(request);
		if (!source)
			return oauthError(503, 'temporarily_unavailable', 'Registration is not available.');
		const time = now();
		for (const [key, limit] of [
			[`source:${source}`, registrationsPerSourceHour],
			['all', registrationsPerHour]
		] as const) {
			const budget = await countRegistration(db, key, time, limit);
			if (!budget.allowed)
				return oauthError(429, 'temporarily_unavailable', 'Too many registrations. Try later.', {
					'retry-after': String(budget.retryAfterSeconds)
				});
		}
		return backChannel(request, '/oauth2/register');
	}

	// The signed-in person's workspace, or a JSON error response.
	async function signedIn(request: Request) {
		const principal = await readPrincipal(auth().api, copyHeaders(request, ['cookie']));
		if (!principal) return oauthError(401, 'login_required', 'Sign in to continue.');
		const tenant = await resolveTenant(db, principal.user.id);
		if (tenant.status !== 'active')
			return oauthError(409, 'workspace_unavailable', 'Your workspace is not ready.');
		return principal;
	}

	// What the consent page shows, from the signed query that the provider sent it.
	async function consentRequest(request: Request, url: URL): Promise<Response> {
		if (request.method !== 'GET') return methodNotAllowed('GET');
		const principal = await signedIn(request);
		if (principal instanceof Response) return principal;
		const signed = url.search.slice(1);
		if (!(await verifyOAuthQueryParams(signed, config.secret)))
			return oauthError(400, 'invalid_request', 'This request has expired. Start again.');
		const params = new URLSearchParams(signed);
		const clientId = params.get('client_id') ?? '';
		let redirect: URL;
		try {
			redirect = new URL(params.get('redirect_uri') ?? '');
		} catch {
			return oauthError(400, 'invalid_request', 'This request has no valid redirect.');
		}
		const client = await db
			.prepare('SELECT "name", "uri" FROM "oauthClient" WHERE "clientId" = ?')
			.bind(clientId)
			.first<Record<string, unknown>>();
		if (!client) return oauthError(400, 'invalid_client', 'This app is not registered.');
		const requested = (params.get('scope') ?? '').split(' ');
		const body: ConsentRequest = {
			client: {
				name: storedName(client.name, redirect.host || clientId),
				uri: storedUri(client.uri)
			},
			redirectHost: redirect.host || redirect.protocol.replace(/:$/, ''),
			// Registration allows plain HTTP and app schemes only for apps on this computer.
			redirectLoopback: redirect.protocol !== 'https:' || isLoopback(redirect.hostname),
			scopes: requested.filter(isTokenScope) satisfies TokenScope[],
			offlineAccess: requested.includes('offline_access')
		};
		return respond(Response.json(body));
	}

	// The consent page posts the decision with the session cookie, from the exact origin.
	async function consent(request: Request): Promise<Response> {
		if (request.method !== 'POST') return methodNotAllowed('POST');
		if (request.headers.get('origin') !== config.origin)
			return oauthError(403, 'invalid_request', 'This request must come from the Flared app.');
		const principal = await signedIn(request);
		if (principal instanceof Response) return principal;
		const body = await readBody(request);
		let input: unknown = null;
		try {
			input = body ? JSON.parse(new TextDecoder().decode(body)) : null;
		} catch {
			input = null;
		}
		const accept = (input as Record<string, unknown> | null)?.accept;
		const query = (input as Record<string, unknown> | null)?.oauth_query;
		if (typeof accept !== 'boolean' || typeof query !== 'string')
			return oauthError(400, 'invalid_request', 'Send accept and oauth_query.');
		const headers = copyHeaders(request, ['cookie', 'origin']);
		headers.set('content-type', 'application/json');
		headers.set('accept', 'application/json');
		const response = await auth().handler(
			new Request(internal('/oauth2/consent'), {
				method: 'POST',
				headers,
				body: JSON.stringify({ accept, oauth_query: query })
			})
		);
		if (response.status !== 200) return respond(response);
		const result = (await response.json()) as Record<string, unknown>;
		if (typeof result.url !== 'string') throw new Error('Consent returned no redirect');
		return respond(Response.json({ redirectTo: result.url }));
	}

	return {
		async fetch(request: Request): Promise<Response> {
			const url = new URL(request.url);
			try {
				switch (url.pathname) {
					case '/.well-known/oauth-authorization-server':
						return await metadata(request);
					case '/oauth2/authorize':
						return await authorize(request, url);
					case '/oauth2/token':
					case '/oauth2/revoke':
						return await backChannel(request, url.pathname);
					case '/oauth2/register':
						return await register(request);
					case '/oauth2/consent':
						return await consent(request);
					case '/oauth2/consent/request':
						return await consentRequest(request, url);
					default:
						return oauthError(404, 'not_found', 'Not found.');
				}
			} catch {
				console.error(JSON.stringify({ event: 'oauth_route_failed', path: url.pathname }));
				return oauthError(503, 'temporarily_unavailable', 'Try again later.');
			}
		}
	};
}
