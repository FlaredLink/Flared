// SPDX-License-Identifier: AGPL-3.0-only
// The application side of the auth routes: the method table, the forwarder for browser
// requests, and the session and passkey reads for server-rendered pages.
import type { PasskeyPage, PasskeySummary } from '@flared/contracts/passkeys';
import type { AuthPrincipal } from '../auth/session';
import { finalizeAuthResponse, forwardAuthRequest, type AuthService } from './forward';

export type AuthMethods = Record<string, 'GET' | 'POST'>;

// The routes of every edition. Each edition adds its sign-in routes.
export const sharedAuthMethods: AuthMethods = {
	'/api/auth/session': 'GET',
	'/api/auth/sign-out': 'POST',
	'/api/auth/reauth/passkey/options': 'POST',
	'/api/auth/reauth/passkey/verify': 'POST',
	'/api/auth/passkey/sign-in/options': 'POST',
	'/api/auth/passkey/sign-in/verify': 'POST',
	'/api/auth/passkey/register/options': 'POST',
	'/api/auth/passkey/register/verify': 'POST',
	'/api/auth/passkeys': 'GET',
	'/api/auth/passkey/rename': 'POST',
	'/api/auth/passkey/delete': 'POST'
};

export type AuthState =
	| { status: 'authenticated'; principal: AuthPrincipal }
	| { status: 'anonymous' }
	| { status: 'unavailable' };

function response(body: unknown, status: number, headers: HeadersInit = {}): Response {
	const result = new Headers(headers);
	result.set('content-type', 'application/json');
	return finalizeAuthResponse(new Response(JSON.stringify(body), { status, headers: result }));
}

function safePrincipal(value: unknown): AuthPrincipal | null {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (
		typeof record.sessionId !== 'string' ||
		!record.sessionId ||
		typeof record.expiresAt !== 'string' ||
		typeof record.signedInAt !== 'string' ||
		typeof record.user !== 'object' ||
		record.user === null
	)
		return null;
	const user = record.user as Record<string, unknown>;
	if (
		typeof user.id !== 'string' ||
		!user.id ||
		typeof user.email !== 'string' ||
		!user.email ||
		typeof user.name !== 'string' ||
		!user.name
	)
		return null;
	return {
		user: { id: user.id, email: user.email, name: user.name },
		sessionId: record.sessionId,
		expiresAt: record.expiresAt,
		signedInAt: record.signedInAt
	};
}

export interface AuthForwarding {
	// The edition's full method table.
	methods: AuthMethods;
	// Routes rate-limited by request source, which need the trusted client address.
	sourceLimited(path: string): boolean;
}

// Forwards a browser request to the auth routes with a fixed set of headers.
export async function forwardAuthRoute(
	request: Request,
	service: AuthService | null,
	clientAddress: string | null,
	routes: AuthForwarding
): Promise<Response> {
	const path = new URL(request.url).pathname;
	const expectedMethod = Object.hasOwn(routes.methods, path) ? routes.methods[path] : undefined;
	if (!expectedMethod) return response({ error: { code: 'NOT_FOUND' } }, 404);
	if (request.method !== expectedMethod)
		return response({ error: { code: 'METHOD_NOT_ALLOWED' } }, 405, { allow: expectedMethod });
	if (routes.sourceLimited(path) && !clientAddress)
		return response({ error: { code: 'AUTH_UNAVAILABLE' } }, 503);
	if (!service) return response({ error: { code: 'AUTH_UNAVAILABLE' } }, 503);
	try {
		const body = request.method === 'GET' ? undefined : await request.arrayBuffer();
		const upstreamRequest = new Request(request.url, {
			method: request.method,
			headers: request.headers,
			body
		});
		return await forwardAuthRequest(
			upstreamRequest,
			service,
			new URL(request.url).origin,
			clientAddress
		);
	} catch {
		return response({ error: { code: 'AUTH_UNAVAILABLE' } }, 503);
	}
}

export async function getAuthState(
	service: AuthService,
	headers: Headers,
	origin: string
): Promise<AuthState> {
	const forwarded = new Headers();
	const cookie = headers.get('cookie');
	if (cookie !== null) forwarded.set('cookie', cookie);
	try {
		const result = await service.fetch(
			new Request(new URL('/api/auth/session', origin), { method: 'GET', headers: forwarded })
		);
		if (result.status === 401) return { status: 'anonymous' };
		if (result.status !== 200) return { status: 'unavailable' };
		const principal = safePrincipal(await result.json().catch(() => null));
		return principal ? { status: 'authenticated', principal } : { status: 'unavailable' };
	} catch {
		return { status: 'unavailable' };
	}
}

function passkeySummary(value: unknown): PasskeySummary | null {
	if (typeof value !== 'object' || value === null) return null;
	if (
		!('id' in value && typeof value.id === 'string') ||
		!('name' in value && (value.name === null || typeof value.name === 'string')) ||
		!('createdAt' in value && (value.createdAt === null || typeof value.createdAt === 'string')) ||
		!('backedUp' in value && typeof value.backedUp === 'boolean')
	)
		return null;
	return { id: value.id, name: value.name, createdAt: value.createdAt, backedUp: value.backedUp };
}

// The signed-in user's passkeys, or null when the list cannot be read.
export async function getPasskeys(
	service: AuthService,
	headers: Headers,
	origin: string
): Promise<PasskeyPage | null> {
	const forwarded = new Headers();
	const cookie = headers.get('cookie');
	if (cookie !== null) forwarded.set('cookie', cookie);
	try {
		const result = await service.fetch(
			new Request(new URL('/api/auth/passkeys', origin), { method: 'GET', headers: forwarded })
		);
		if (result.status !== 200) return null;
		const value: unknown = await result.json().catch(() => null);
		if (
			typeof value !== 'object' ||
			value === null ||
			!('passkeys' in value && Array.isArray(value.passkeys)) ||
			!(
				'freshUntil' in value &&
				(value.freshUntil === null || typeof value.freshUntil === 'string')
			)
		)
			return null;
		const passkeys = value.passkeys.map(passkeySummary);
		if (passkeys.some((passkey) => passkey === null)) return null;
		return {
			passkeys: passkeys.filter((passkey): passkey is PasskeySummary => passkey !== null),
			freshUntil: value.freshUntil
		};
	} catch {
		return null;
	}
}
