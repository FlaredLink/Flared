// SPDX-License-Identifier: AGPL-3.0-only
// Standalone sign-in: username and password, plus the shared passkey routes. No public sign-up,
// email, or account-linking route exists. Setup creates the owner; a member's account comes
// only from an invite link, and a member's new password only from the owner's reset link. Each
// route reserves a budget before any hash runs, and sign-in answers every credential failure
// the same way.
import { betterAuth } from 'better-auth';
import { username } from 'better-auth/plugins';
import type { Hono } from 'hono';
import { createIdentityAdapter } from '@flared/data/identity-adapter';
import { ensurePlatformDomain } from '@flared/data/domains';
import { installD1ProofGuards } from '@flared/data/identity-proof-guards';
import {
	acceptLinkInvite,
	readLinkInvite,
	readPasswordReset,
	usePasswordReset
} from '@flared/data/members';
import { moveAppOrigin } from '@flared/data/setup';
import type { LinkInvitePreview, PasswordResetPreview } from '@flared/contracts/members';
import { hashInviteToken } from '../members';
import type { AuthMethods } from '../web/auth';
import { reserveAttempt, type AttemptKind } from './attempts';
import { keyedHash } from './limits';
import { createSessionOptions } from './options';
import { createPasskeyPlugin } from './passkey';
import { hashPassword, verifyPassword } from './password';
import {
	authenticated,
	authFailure,
	authJson,
	createAuthRoutes,
	rateLimited,
	trustedSource,
	type SignInRouteInput
} from './routes';
import { freshUntil, type AuthPrincipal } from './session';
import { AuthInputError, exactRecord } from './validation';

export const minPasswordLength = 12;
export const maxPasswordLength = 128;
// The username plugin's defaults: 3 to 30 letters, digits, underscores, or dots, stored in
// lower case.
export const usernamePattern = /^[a-zA-Z0-9_.]{3,30}$/;

// Better Auth requires a unique email. The owner's and each member's is an internal address
// that is never verified, shown, or sent to.
export function ownerEmail(userId: string): string {
	return `${userId}@owner.invalid`;
}

export interface OwnerAuthConfig {
	origin: string;
	secret: string;
	// Keys the request budgets, so they store no addresses.
	rateLimitSecret: string;
}

export async function createOwnerAuth(db: D1Database, config: OwnerAuthConfig) {
	const auth = betterAuth({
		...createSessionOptions(config.origin),
		secret: config.secret,
		database: createIdentityAdapter(db),
		rateLimit: { enabled: false },
		verification: { disableCleanup: true },
		logger: { disabled: true },
		// Email sign-up, sign-in, and reset stay off; the username plugin signs in on its own.
		emailAndPassword: {
			enabled: false,
			minPasswordLength,
			maxPasswordLength,
			password: { hash: hashPassword, verify: verifyPassword }
		},
		// This fixed trusted plugin list is part of the proof-guard contract.
		plugins: [username(), createPasskeyPlugin(config.origin, 'Flared')]
	});
	installD1ProofGuards(await auth.$context, db);
	return auth;
}

export type OwnerAuth = Awaited<ReturnType<typeof createOwnerAuth>>;

export const ownerSignInMethods: AuthMethods = {
	'/api/auth/sign-in/password': 'POST',
	'/api/auth/reauth/password': 'POST',
	'/api/auth/password/change': 'POST',
	'/api/auth/invite/lookup': 'POST',
	'/api/auth/invite/accept': 'POST',
	'/api/auth/password/reset/lookup': 'POST',
	'/api/auth/password/reset': 'POST'
};

// The routes that need the trusted client address.
const sourceLimitedPaths = new Set([
	'/api/auth/sign-in/password',
	'/api/auth/passkey/sign-in/options',
	'/api/auth/reauth/passkey/options',
	'/api/auth/invite/lookup',
	'/api/auth/invite/accept',
	'/api/auth/password/reset/lookup',
	'/api/auth/password/reset'
]);

export function ownerSourceLimited(path: string): boolean {
	return sourceLimitedPaths.has(path);
}

function password(value: unknown): string {
	if (typeof value !== 'string' || value.length < 1 || value.length > maxPasswordLength)
		throw new AuthInputError(400, 'INVALID_REQUEST');
	return value;
}

// A password that setup or a change stores.
export function isNewPassword(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length >= minPasswordLength &&
		value.length <= maxPasswordLength
	);
}

function signInBody(value: unknown): { username: string; password: string } {
	const record = exactRecord(value, ['username', 'password']);
	if (typeof record.username !== 'string' || record.username.length > 64)
		throw new AuthInputError(400, 'INVALID_REQUEST');
	return { username: record.username.trim(), password: password(record.password) };
}

function changeBody(value: unknown): { currentPassword: string; newPassword: string } {
	const record = exactRecord(value, ['currentPassword', 'newPassword']);
	if (!isNewPassword(record.newPassword)) throw new AuthInputError(400, 'INVALID_REQUEST');
	return { currentPassword: password(record.currentPassword), newPassword: record.newPassword };
}

// An invite or reset token from a link's fragment.
function linkToken(value: unknown): string {
	if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{20,100}$/.test(value))
		throw new AuthInputError(400, 'INVALID_REQUEST');
	return value;
}

function acceptBody(value: unknown): { token: string; username: string; password: string } {
	const record = exactRecord(value, ['token', 'username', 'password']);
	const name = typeof record.username === 'string' ? record.username.trim() : '';
	if (!usernamePattern.test(name) || !isNewPassword(record.password))
		throw new AuthInputError(400, 'INVALID_REQUEST');
	return { token: linkToken(record.token), username: name, password: record.password };
}

function resetBody(value: unknown): { token: string; newPassword: string } {
	const record = exactRecord(value, ['token', 'newPassword']);
	if (!isNewPassword(record.newPassword)) throw new AuthInputError(400, 'INVALID_REQUEST');
	return { token: linkToken(record.token), newPassword: record.newPassword };
}

const invalidCredentials = () => authFailure('INVALID_CREDENTIALS', 401);
const inviteEnded = () => authFailure('INVITE_NOT_FOUND', 404);
const resetEnded = () => authFailure('RESET_NOT_FOUND', 404);

// The user ID and session token of a successful sign-in response.
async function signedInSession(
	response: Response
): Promise<{ userId: string | null; token: string | null }> {
	const body: unknown = await response
		.clone()
		.json()
		.catch(() => null);
	if (typeof body !== 'object' || body === null) return { userId: null, token: null };
	const token = 'token' in body && typeof body.token === 'string' ? body.token : null;
	const user = 'user' in body ? body.user : null;
	const userId =
		typeof user === 'object' && user !== null && 'id' in user && typeof user.id === 'string'
			? user.id
			: null;
	return { userId, token };
}

export interface OwnerRouteOptions {
	db: D1Database;
	config: OwnerAuthConfig;
	// Creates the auth instance on first use; tests pass a shared one.
	auth?: () => Promise<OwnerAuth>;
	// A standalone Worker records the app origin at each password sign-in. When it differs from
	// the stored one, credentials bound to the old origin end and the new host becomes a link
	// domain in this routing store.
	originMove?: { routing: D1Database };
	now?: () => number;
}

export function createOwnerAuthRoutes(options: OwnerRouteOptions): Hono {
	const { db, config } = options;
	const now = options.now ?? Date.now;
	let instance: Promise<OwnerAuth> | undefined;
	const getAuth = () => (instance ??= options.auth?.() ?? createOwnerAuth(db, config));

	async function reserve(kind: AttemptKind, subject: string): Promise<Response | null> {
		const key = await keyedHash(config.rateLimitSecret, `${kind}:${subject}`);
		const budget = await reserveAttempt(db, kind, key, now());
		return budget.allowed ? null : rateLimited(budget.retryAfter);
	}

	// Signs the owner in with the library, which hashes even for an unknown username. Every
	// refusal is the same 401.
	async function signIn(name: string, secret: string, headers: Headers) {
		const { api } = await getAuth();
		const result = await api
			.signInUsername({ body: { username: name, password: secret }, headers, asResponse: true })
			.catch(() => null);
		if (!result) return { ok: false as const, response: authFailure('AUTH_UNAVAILABLE', 503) };
		if (result.status === 200) return { ok: true as const, result };
		return {
			ok: false as const,
			response: [400, 401, 403, 422].includes(result.status)
				? invalidCredentials()
				: authFailure('AUTH_UNAVAILABLE', 503)
		};
	}

	async function passwordSignIn({ body, request, headers }: SignInRouteInput) {
		const input = signInBody(body);
		const source = trustedSource(request);
		if (!source) return authFailure('AUTH_UNAVAILABLE', 503);
		const refused = await reserve('sign_in', source);
		if (refused) return refused;
		const outcome = await signIn(input.username, input.password, headers);
		if (!outcome.ok) return outcome.response;
		if (options.originMove) {
			const { token } = await signedInSession(outcome.result);
			if (!token) return authFailure('AUTH_UNAVAILABLE', 503);
			await moveAppOrigin(db, token, config.origin, now());
			// Safe to repeat, so a failed earlier attempt finishes here.
			await ensurePlatformDomain(
				options.originMove.routing,
				new URL(config.origin).hostname,
				now()
			);
		}
		return authenticated(outcome.result);
	}

	// The username comes from the session, so reauthentication cannot switch users. A new
	// session of another user is still refused and deleted.
	async function passwordReauth(principal: AuthPrincipal, { body, headers }: SignInRouteInput) {
		const input = exactRecord(body, ['password']);
		const secret = password(input.password);
		const refused = await reserve('reauth', principal.user.id);
		if (refused) return refused;
		const outcome = await signIn(principal.user.name, secret, headers);
		if (!outcome.ok) return outcome.response;
		const session = await signedInSession(outcome.result);
		if (session.userId !== principal.user.id) {
			if (session.token)
				await db.prepare('DELETE FROM session WHERE token = ?').bind(session.token).run();
			return invalidCredentials();
		}
		return authenticated(outcome.result);
	}

	// Verifies the current password first, because the library would hash the new one first.
	// Then it stores the new hash, ends every session of the owner, and signs in again. If a
	// step after the update fails, every session is already gone and the owner signs in with
	// the new password.
	async function passwordChange(principal: AuthPrincipal, { body, headers }: SignInRouteInput) {
		const input = changeBody(body);
		if (freshUntil(principal, now()) === null) return authFailure('REAUTH_REQUIRED', 403);
		const refused = await reserve('password_change', principal.user.id);
		if (refused) return refused;
		const context = await (await getAuth()).$context;
		const account = await db
			.prepare(
				"SELECT id, password FROM account WHERE userId = ? AND providerId = 'credential' AND password IS NOT NULL"
			)
			.bind(principal.user.id)
			.first<{ id: string; password: string }>();
		if (!account) return invalidCredentials();
		if (
			!(await context.password.verify({ hash: account.password, password: input.currentPassword }))
		)
			return invalidCredentials();
		const hash = await context.password.hash(input.newPassword);
		const time = now();
		const [updated] = await db.batch([
			db
				.prepare('UPDATE account SET password = ?, updatedAt = ? WHERE id = ? AND password = ?')
				.bind(hash, time, account.id, account.password),
			db
				.prepare(
					'DELETE FROM session WHERE userId = ? AND EXISTS (SELECT 1 FROM account WHERE id = ? AND password = ?)'
				)
				.bind(principal.user.id, account.id, hash),
			db
				.prepare(
					"INSERT INTO owner_audit (id, action, created_at) SELECT ?, 'password_changed', ? WHERE EXISTS (SELECT 1 FROM account WHERE id = ? AND password = ?)"
				)
				.bind(crypto.randomUUID(), time, account.id, hash)
		]);
		// Another change won the race; this one changed nothing.
		if (updated.meta.changes !== 1) return authFailure('CONFLICT', 409);
		const outcome = await signIn(principal.user.name, input.newPassword, headers);
		return outcome.ok ? authenticated(outcome.result) : authFailure('AUTH_UNAVAILABLE', 503);
	}

	// The links are the secret, so each use of one spends the address's sign-in budget.
	async function reserveSource(request: Request): Promise<Response | null> {
		const source = trustedSource(request);
		if (!source) return authFailure('AUTH_UNAVAILABLE', 503);
		return reserve('sign_in', source);
	}

	async function inviteLookup({ body, request }: SignInRouteInput) {
		const token = linkToken(exactRecord(body, ['token']).token);
		const refused = await reserveSource(request);
		if (refused) return refused;
		const invite = await readLinkInvite(db, await hashInviteToken(token), now());
		if (!invite) return inviteEnded();
		const preview: LinkInvitePreview = {
			workspaceName: invite.workspaceName,
			expiresAt: new Date(invite.expiresAt).toISOString()
		};
		return authJson(preview);
	}

	// Creates the member's account from an open invite link and signs them in. The checks before
	// the hash keep a stale link or a taken name from costing a hash.
	async function inviteAccept({ body, request, headers }: SignInRouteInput) {
		const input = acceptBody(body);
		const refused = await reserveSource(request);
		if (refused) return refused;
		const tokenHash = await hashInviteToken(input.token);
		if (!(await readLinkInvite(db, tokenHash, now()))) return inviteEnded();
		const taken = await db
			.prepare('SELECT 1 AS found FROM "user" WHERE username = ?')
			.bind(input.username.toLowerCase())
			.first();
		if (taken) return authFailure('USERNAME_TAKEN', 409);
		const context = await (await getAuth()).$context;
		const userId = crypto.randomUUID();
		const result = await acceptLinkInvite(db, {
			tokenHash,
			userId,
			username: input.username.toLowerCase(),
			displayUsername: input.username,
			email: ownerEmail(userId),
			accountId: crypto.randomUUID(),
			passwordHash: await context.password.hash(input.password),
			now: now()
		});
		if (result.status === 'username_taken') return authFailure('USERNAME_TAKEN', 409);
		if (result.status === 'invalid') return inviteEnded();
		const outcome = await signIn(input.username, input.password, headers);
		return outcome.ok ? authenticated(outcome.result) : authFailure('AUTH_UNAVAILABLE', 503);
	}

	async function resetLookup({ body, request }: SignInRouteInput) {
		const token = linkToken(exactRecord(body, ['token']).token);
		const refused = await reserveSource(request);
		if (refused) return refused;
		const reset = await readPasswordReset(db, await hashInviteToken(token), now());
		if (!reset) return resetEnded();
		const preview: PasswordResetPreview = {
			username: reset.username,
			workspaceName: reset.workspaceName,
			expiresAt: new Date(reset.expiresAt).toISOString()
		};
		return authJson(preview);
	}

	// Sets the member's new password from an open reset link, which ends their sessions, then
	// signs them in.
	async function passwordReset({ body, request, headers }: SignInRouteInput) {
		const input = resetBody(body);
		const refused = await reserveSource(request);
		if (refused) return refused;
		const tokenHash = await hashInviteToken(input.token);
		const reset = await readPasswordReset(db, tokenHash, now());
		if (!reset) return resetEnded();
		const context = await (await getAuth()).$context;
		const passwordHash = await context.password.hash(input.newPassword);
		if (!(await usePasswordReset(db, { tokenHash, passwordHash, now: now() }))) return resetEnded();
		const outcome = await signIn(reset.username, input.newPassword, headers);
		return outcome.ok ? authenticated(outcome.result) : authFailure('AUTH_UNAVAILABLE', 503);
	}

	async function handle(input: SignInRouteInput): Promise<Response> {
		if (input.path === '/api/auth/sign-in/password') return passwordSignIn(input);
		if (input.path === '/api/auth/invite/lookup') return inviteLookup(input);
		if (input.path === '/api/auth/invite/accept') return inviteAccept(input);
		if (input.path === '/api/auth/password/reset/lookup') return resetLookup(input);
		if (input.path === '/api/auth/password/reset') return passwordReset(input);
		const principal = await input.principal();
		if (!principal) return authFailure('UNAUTHENTICATED', 401);
		if (input.path === '/api/auth/reauth/password') return passwordReauth(principal, input);
		if (input.path === '/api/auth/password/change') return passwordChange(principal, input);
		return authJson({ error: { code: 'NOT_FOUND' } }, 404);
	}

	return createAuthRoutes({
		auth: getAuth,
		db,
		origin: config.origin,
		rateLimitSecret: config.rateLimitSecret,
		passkeyAttemptsTable: 'passkey_attempts',
		identityRule: { kind: 'username', db },
		signIn: { methods: ownerSignInMethods, handle },
		now
	});
}
