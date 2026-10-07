// SPDX-License-Identifier: AGPL-3.0-only
// The /api/auth/* routes every edition shares: session, sign-out, passkey sign-in, passkey
// registration and management, and passkey reauthentication. Each edition adds its own sign-in
// routes. Only the paths in the combined method table reach the library, and every response
// leaves with the auth response headers.
import { isIP } from 'node:net';
import { Hono } from 'hono';
import { withIdentityProofScope } from '@flared/data/identity-proof-guards';
import type { PasskeyPage } from '@flared/contracts/passkeys';
import { EmailDeliveryError } from '../email/transport';
import { finalizeAuthResponse } from '../web/forward';
import { sharedAuthMethods, type AuthMethods } from '../web/auth';
import { consumePasskeyBudget } from './limits';
import { freshUntil, readPrincipal, type AuthPrincipal } from './session';
import {
	AuthInputError,
	emptyBody,
	passkeyIdBody,
	passkeyRegistrationBody,
	passkeyRenameBody,
	passkeySignInBody,
	readAuthBody
} from './validation';

type PasskeyResponse = ReturnType<typeof passkeySignInBody>['response'];
type RegistrationResponse = ReturnType<typeof passkeyRegistrationBody>['response'];

// The library calls these routes make. A Better Auth instance with the shared passkey plugin
// provides them.
export interface SharedAuthApi {
	getSession(input: { headers: Headers; query: { disableCookieCache: boolean } }): Promise<unknown>;
	signOut(input: { headers: Headers; asResponse: true }): Promise<Response>;
	generatePasskeyAuthenticationOptions(input: {
		headers: Headers;
		asResponse: true;
	}): Promise<Response>;
	verifyPasskeyAuthentication(input: {
		body: { response: PasskeyResponse };
		headers: Headers;
		asResponse: true;
	}): Promise<Response>;
	generatePasskeyRegistrationOptions(input: {
		headers: Headers;
		query: { name: string };
		asResponse: true;
	}): Promise<Response>;
	verifyPasskeyRegistration(input: {
		body: { response: RegistrationResponse; name: string };
		headers: Headers;
		asResponse: true;
	}): Promise<Response>;
	updatePasskey(input: {
		body: { id: string; name: string };
		headers: Headers;
		asResponse: true;
	}): Promise<Response>;
	deletePasskey(input: {
		body: { id: string };
		headers: Headers;
		asResponse: true;
	}): Promise<Response>;
	listPasskeys(input: {
		headers: Headers;
	}): Promise<{ id: string; name?: string | null; createdAt?: Date | null; backedUp: boolean }[]>;
}

export function authJson(body: unknown, status = 200, headers: HeadersInit = {}): Response {
	const result = new Headers(headers);
	result.set('content-type', 'application/json');
	return new Response(JSON.stringify(body), { status, headers: result });
}

export function authFailure(code: string, status: number): Response {
	return authJson({ error: { code } }, status);
}

// A sign-in that set a session cookie answers { ok: true } with only the cookies.
export function authenticated(response: Response): Response {
	if (!response.headers.getSetCookie().some((cookie) => cookie.includes('session_token=')))
		return authFailure('AUTH_UNAVAILABLE', 503);
	const headers = new Headers();
	for (const value of response.headers.getSetCookie()) headers.append('set-cookie', value);
	return authJson({ ok: true }, 200, headers);
}

export function rateLimited(retryAfter: number): Response {
	return authJson({ error: { code: 'RATE_LIMITED' }, retryAfter }, 429, {
		'retry-after': String(retryAfter)
	});
}

// The client address set by the edition's entry Worker, never by the browser.
export function trustedSource(request: Request): string | null {
	const source = request.headers.get('x-flared-source');
	return source && isIP(source) !== 0 ? source : null;
}

function safeLibraryHeaders(request: Request): Headers {
	const headers = new Headers();
	for (const name of ['origin', 'cookie']) {
		const value = request.headers.get(name);
		if (value !== null) headers.set(name, value);
	}
	return headers;
}

// Passkey options carry their challenge in a signed cookie; pass on that cookie and no other.
const challengeCookie = /^(__Secure-)?better-auth\.better-auth-passkey=/;
async function withChallenge(response: Response): Promise<Response> {
	if (response.status !== 200) return authFailure('AUTH_UNAVAILABLE', 503);
	const headers = new Headers();
	for (const value of response.headers.getSetCookie())
		if (challengeCookie.test(value)) headers.append('set-cookie', value);
	return authJson({ options: await response.json() }, 200, headers);
}

// 1.7.7 reports a rejected credential as 400 or 401, and wraps SimpleWebAuthn's origin and
// relying-party errors as 500. Storage faults inside the plugin also surface as 500, so a person
// sees one "not accepted" answer for all of them.
function rejected(response: Response, accepted: () => Response): Response {
	if (response.status === 200) return accepted();
	if (response.status === 403) return authFailure('REAUTH_REQUIRED', 403);
	if ([400, 401, 500].includes(response.status)) return authFailure('PASSKEY_REJECTED', 400);
	return authFailure('AUTH_UNAVAILABLE', 503);
}

// Another user's passkey and a missing one look the same.
function owned(response: Response): Response {
	if (response.status === 200) return authJson({ ok: true });
	if ([401, 403, 404].includes(response.status)) return authFailure('NOT_FOUND', 404);
	return authFailure('AUTH_UNAVAILABLE', 503);
}

export interface SignInRouteInput {
	path: string;
	body: unknown;
	request: Request;
	// The origin and cookie headers only.
	headers: Headers;
	// The signed-in principal of this request, or null.
	principal(): Promise<AuthPrincipal | null>;
}

// An edition's own sign-in and reauthentication routes, such as email codes.
export interface SignInRoutes {
	methods: AuthMethods;
	handle(input: SignInRouteInput): Promise<Response>;
}

export interface AuthRouteOptions {
	// Creates the auth instance on first use.
	auth(): Promise<{ api: SharedAuthApi }>;
	db: D1Database;
	// The exact application origin from deployment configuration.
	origin: string;
	// Keys the passkey budget, so the table stores no addresses.
	rateLimitSecret: string;
	// The edition's table of passkey challenge attempts.
	passkeyAttemptsTable: string;
	signIn: SignInRoutes;
	now?: () => number;
}

export function createAuthRoutes(options: AuthRouteOptions): Hono {
	const app = new Hono();
	const now = options.now ?? Date.now;
	const methods: AuthMethods = { ...sharedAuthMethods, ...options.signIn.methods };
	let auth: Promise<{ api: SharedAuthApi }> | undefined;
	const getAuth = () => (auth ??= options.auth());
	async function signedIn(headers: Headers): Promise<AuthPrincipal | null> {
		return readPrincipal((await getAuth()).api, headers);
	}

	// Authentication options for passkey sign-in and passkey reauthentication, under the
	// per-source passkey budget.
	async function authenticationOptions(body: unknown, request: Request, headers: Headers) {
		emptyBody(body);
		const source = trustedSource(request);
		if (!source) return authFailure('AUTH_UNAVAILABLE', 503);
		const budget = await consumePasskeyBudget(
			options.db,
			options.passkeyAttemptsTable,
			options.rateLimitSecret,
			source,
			now()
		);
		if (!budget.allowed) return rateLimited(budget.retryAfter);
		const { api } = await getAuth();
		return withChallenge(
			await withIdentityProofScope('issue', () =>
				api.generatePasskeyAuthenticationOptions({ headers, asResponse: true })
			)
		);
	}

	async function passkeySignIn(body: unknown, headers: Headers): Promise<Response> {
		const input = passkeySignInBody(body);
		const { api } = await getAuth();
		const result = await withIdentityProofScope('verify', () =>
			api.verifyPasskeyAuthentication({
				// The pinned library validates the WebAuthn response structure itself.
				body: { response: input.response },
				headers,
				asResponse: true
			})
		);
		return rejected(result, () => authenticated(result));
	}

	// Passkey management and passkey reauthentication for the signed-in user.
	async function signedInRoute(
		path: string,
		body: unknown,
		headers: Headers,
		principal: AuthPrincipal
	): Promise<Response> {
		const { api } = await getAuth();
		const fresh = freshUntil(principal, now()) !== null;
		if (path === '/api/auth/reauth/passkey/verify') {
			const input = passkeySignInBody(body);
			// Reauthentication must not switch accounts. The library would sign in whoever owns
			// the passkey, so a passkey of another user is refused before it runs.
			const owner = await options.db
				.prepare('SELECT userId FROM passkey WHERE credentialID = ?')
				.bind(input.response.id)
				.first<{ userId: string }>();
			if (owner?.userId !== principal.user.id) return authFailure('PASSKEY_REJECTED', 400);
			const result = await withIdentityProofScope('verify', () =>
				api.verifyPasskeyAuthentication({
					body: { response: input.response },
					headers,
					asResponse: true
				})
			);
			return rejected(result, () => authenticated(result));
		}
		if (path === '/api/auth/passkey/register/options') {
			emptyBody(body);
			if (!fresh) return authFailure('REAUTH_REQUIRED', 403);
			return withChallenge(
				await withIdentityProofScope('issue', () =>
					api.generatePasskeyRegistrationOptions({
						headers,
						query: { name: principal.user.email },
						asResponse: true
					})
				)
			);
		}
		if (path === '/api/auth/passkey/register/verify') {
			const input = passkeyRegistrationBody(body);
			if (!fresh) return authFailure('REAUTH_REQUIRED', 403);
			const result = await withIdentityProofScope('verify', () =>
				api.verifyPasskeyRegistration({
					body: { response: input.response, name: input.name },
					headers,
					asResponse: true
				})
			);
			return rejected(result, () => authJson({ ok: true }));
		}
		if (path === '/api/auth/passkey/rename') {
			const input = passkeyRenameBody(body);
			return owned(await api.updatePasskey({ body: input, headers, asResponse: true }));
		}
		if (path === '/api/auth/passkey/delete') {
			const input = passkeyIdBody(body);
			// The library deletes with any session; deletion is a credential change.
			if (!fresh) return authFailure('REAUTH_REQUIRED', 403);
			return owned(await api.deletePasskey({ body: input, headers, asResponse: true }));
		}
		return authFailure('NOT_FOUND', 404);
	}

	app.onError(() => finalizeAuthResponse(authFailure('AUTH_UNAVAILABLE', 503)));
	app.use('*', async (context, next) => {
		await next();
		context.res = finalizeAuthResponse(context.res);
	});
	app.all('*', async (context) => {
		try {
			const request = context.req.raw;
			const path = new URL(request.url).pathname;
			const method = Object.hasOwn(methods, path) ? methods[path] : undefined;
			if (!method) return authFailure('NOT_FOUND', 404);
			if (request.method !== method)
				return authJson({ error: { code: 'METHOD_NOT_ALLOWED' } }, 405, { allow: method });
			const headers = safeLibraryHeaders(request);
			if (path === '/api/auth/session') {
				const principal = await signedIn(headers);
				return principal ? authJson(principal) : authFailure('UNAUTHENTICATED', 401);
			}
			if (path === '/api/auth/passkeys') {
				const principal = await signedIn(headers);
				if (!principal) return authFailure('UNAUTHENTICATED', 401);
				const passkeys = await (await getAuth()).api.listPasskeys({ headers });
				const page: PasskeyPage = {
					passkeys: passkeys.map((passkey) => ({
						id: passkey.id,
						name: passkey.name ?? null,
						createdAt: passkey.createdAt ? new Date(passkey.createdAt).toISOString() : null,
						backedUp: passkey.backedUp
					})),
					freshUntil: freshUntil(principal, now())
				};
				return authJson(page);
			}
			const body = await readAuthBody(request, options.origin);
			if (!Object.hasOwn(sharedAuthMethods, path))
				return await options.signIn.handle({
					path,
					body,
					request,
					headers,
					principal: () => signedIn(headers)
				});
			if (
				path === '/api/auth/passkey/sign-in/options' ||
				path === '/api/auth/reauth/passkey/options'
			) {
				// Reauthentication options need a session; sign-in options do not.
				if (path === '/api/auth/reauth/passkey/options' && !(await signedIn(headers)))
					return authFailure('UNAUTHENTICATED', 401);
				return await authenticationOptions(body, request, headers);
			}
			if (path === '/api/auth/passkey/sign-in/verify') return await passkeySignIn(body, headers);
			if (path === '/api/auth/sign-out') {
				emptyBody(body);
				const response = await (await getAuth()).api.signOut({ headers, asResponse: true });
				if (response.status !== 200) return authFailure('AUTH_UNAVAILABLE', 503);
				const cookies = new Headers();
				for (const value of response.headers.getSetCookie()) cookies.append('set-cookie', value);
				return authJson({ ok: true }, 200, cookies);
			}
			const principal = await signedIn(headers);
			if (!principal) return authFailure('UNAUTHENTICATED', 401);
			return await signedInRoute(path, body, headers, principal);
		} catch (error) {
			if (error instanceof AuthInputError) return authFailure(error.code, error.status);
			if (error instanceof EmailDeliveryError) return authFailure('EMAIL_UNAVAILABLE', 503);
			return authFailure('AUTH_UNAVAILABLE', 503);
		}
	});
	return app;
}
