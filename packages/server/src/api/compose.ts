// SPDX-License-Identifier: AGPL-3.0-only
// How an edition's Worker authenticates API requests. The app's same-origin API reads only the
// session cookie; the bearer API reads only "Authorization: Bearer" and never cookies.
import type { D1Database } from '@cloudflare/workers-types/index.ts';
import { authenticateBearer, type ApiAuthentication } from '../api';
import type { ApiTokenAuth } from '../auth/api-tokens';
import type { AuthService } from '../web/forward';
import { protectedResourceMetadataUrl } from '../mcp';

export type ApiMode = 'session' | 'bearer';

export function unavailable(): Response {
	return Response.json(
		{
			error: {
				code: 'SERVICE_UNAVAILABLE',
				message: 'The service is not available. Try again.',
				requestId: crypto.randomUUID()
			}
		},
		{ status: 503, headers: { 'cache-control': 'no-store' } }
	);
}

export function database(value: D1Database | undefined): D1Database | null {
	return value && typeof value.prepare === 'function' ? value : null;
}

function field(value: unknown, key: string): unknown {
	if (typeof value !== 'object' || value === null) return undefined;
	return Object.entries(value).find(([name]) => name === key)?.[1];
}

// Reads the session principal from the cookie through the in-process auth routes.
export async function sessionPrincipal(
	request: Request,
	auth: AuthService,
	origin: string
): Promise<ApiAuthentication> {
	const headers = new Headers();
	const cookie = request.headers.get('cookie');
	if (cookie === null) return null;
	headers.set('cookie', cookie);
	const response = await auth.fetch(new Request(new URL('/api/auth/session', origin), { headers }));
	if (response.status === 401) return null;
	if (response.status !== 200) throw new Error('Session lookup unavailable');
	const principal: unknown = await response.json();
	const userId = field(field(principal, 'user'), 'id');
	const sessionId = field(principal, 'sessionId');
	const signedInAt = field(principal, 'signedInAt');
	if (
		typeof userId !== 'string' ||
		!userId ||
		typeof sessionId !== 'string' ||
		!sessionId ||
		typeof signedInAt !== 'string'
	)
		throw new Error('Session lookup returned no user');
	return { kind: 'session', userId, sessionId, signedInAt };
}

// The authenticate function of an API mode. With apiResource, the bearer API also takes OAuth
// access tokens bound to it.
export function apiAuthenticator(
	mode: ApiMode,
	dependencies: {
		identity: D1Database;
		tokenAuth: ApiTokenAuth;
		auth: AuthService;
		origin: string;
		apiResource?: string;
	}
): (request: Request) => Promise<ApiAuthentication> {
	const { identity, tokenAuth, auth, origin, apiResource } = dependencies;
	const oauth = apiResource ? { resource: apiResource } : undefined;
	return (request) =>
		mode === 'bearer'
			? authenticateBearer(tokenAuth, identity, request, oauth)
			: sessionPrincipal(request, auth, origin);
}

// The WWW-Authenticate value of a 401 from the bearer API: where its RFC 9728 metadata is.
export function bearerChallenge(apiResource: string): string {
	return `Bearer resource_metadata="${protectedResourceMetadataUrl(apiResource)}"`;
}
