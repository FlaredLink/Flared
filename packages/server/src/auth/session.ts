// SPDX-License-Identifier: AGPL-3.0-only
import type { D1Database } from '@cloudflare/workers-types/index.ts';
import { freshSessionSeconds } from './options';

export interface AuthPrincipal {
	// name is what the person signs in with: the email in the cloud, the username in standalone.
	user: { id: string; email: string; name: string };
	// The session row ID, which keys the session's active workspace. It is no credential: the
	// session token is.
	sessionId: string;
	expiresAt: string;
	// When this session's sign-in happened.
	signedInAt: string;
}
export interface SessionReader {
	getSession(input: { headers: Headers; query: { disableCookieCache: boolean } }): Promise<unknown>;
}

// Who may hold a session in an edition. Every reader of a session passes its edition's rule.
export type IdentityRule =
	// The cloud: a verified email.
	| { kind: 'verified-email' }
	// Standalone: the owner's username with a password account. The email is an internal
	// .invalid address and is never verified.
	| { kind: 'owner-username'; db: D1Database };

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

async function ownerUsername(db: D1Database, userId: string): Promise<string | null> {
	const row = await db
		.prepare(
			`SELECT u.username FROM "user" u JOIN account a ON a.userId = u.id AND a.providerId = 'credential' WHERE u.id = ?`
		)
		.bind(userId)
		.first<{ username: unknown }>();
	return typeof row?.username === 'string' && row.username ? row.username : null;
}

export async function readPrincipal(
	auth: SessionReader,
	headers: Headers,
	rule: IdentityRule
): Promise<AuthPrincipal | null> {
	const result = await auth.getSession({ headers, query: { disableCookieCache: true } });
	if (!record(result) || !record(result.user) || !record(result.session)) return null;
	const { id, email, emailVerified } = result.user;
	const { id: sessionId, expiresAt, createdAt } = result.session;
	if (
		typeof id !== 'string' ||
		!id ||
		typeof sessionId !== 'string' ||
		!sessionId ||
		typeof email !== 'string' ||
		!email ||
		!(expiresAt instanceof Date) ||
		!Number.isFinite(expiresAt.getTime()) ||
		expiresAt.getTime() <= Date.now() ||
		!(createdAt instanceof Date) ||
		!Number.isFinite(createdAt.getTime())
	)
		return null;
	let name: string | null;
	if (rule.kind === 'verified-email') name = emailVerified === true ? email : null;
	else name = await ownerUsername(rule.db, id);
	if (name === null) return null;
	return {
		user: { id, email, name },
		sessionId,
		expiresAt: expiresAt.toISOString(),
		signedInAt: createdAt.toISOString()
	};
}

// The end of the window in which this session may add or delete credentials, or null once it
// has passed.
export function freshUntil(
	principal: Pick<AuthPrincipal, 'signedInAt'>,
	now = Date.now()
): string | null {
	const until = Date.parse(principal.signedInAt) + freshSessionSeconds * 1000;
	return until > now ? new Date(until).toISOString() : null;
}
