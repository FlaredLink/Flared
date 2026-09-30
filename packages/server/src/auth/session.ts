// SPDX-License-Identifier: AGPL-3.0-only
export interface AuthPrincipal {
	user: { id: string; email: string };
	expiresAt: string;
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
	const expiresAt = result.session.expiresAt;
	if (
		emailVerified !== true ||
		typeof id !== 'string' ||
		!id ||
		typeof email !== 'string' ||
		!email ||
		!(expiresAt instanceof Date) ||
		!Number.isFinite(expiresAt.getTime()) ||
		expiresAt.getTime() <= Date.now()
	)
		return null;
	return { user: { id, email }, expiresAt: expiresAt.toISOString() };
}
