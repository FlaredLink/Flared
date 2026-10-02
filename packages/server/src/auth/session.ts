// SPDX-License-Identifier: AGPL-3.0-only
import { freshSessionSeconds } from './options';

export interface AuthPrincipal {
	user: { id: string; email: string };
	expiresAt: string;
	// When this session's sign-in happened.
	signedInAt: string;
}
export interface SessionReader {
	getSession(input: { headers: Headers; query: { disableCookieCache: boolean } }): Promise<unknown>;
}
function record(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}
export async function readPrincipal(
	auth: SessionReader,
	headers: Headers
): Promise<AuthPrincipal | null> {
	const result = await auth.getSession({ headers, query: { disableCookieCache: true } });
	if (!record(result) || !record(result.user) || !record(result.session)) return null;
	const { id, email, emailVerified } = result.user;
	const { expiresAt, createdAt } = result.session;
	if (
		emailVerified !== true ||
		typeof id !== 'string' ||
		!id ||
		typeof email !== 'string' ||
		!email ||
		!(expiresAt instanceof Date) ||
		!Number.isFinite(expiresAt.getTime()) ||
		expiresAt.getTime() <= Date.now() ||
		!(createdAt instanceof Date) ||
		!Number.isFinite(createdAt.getTime())
	)
		return null;
	return {
		user: { id, email },
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
