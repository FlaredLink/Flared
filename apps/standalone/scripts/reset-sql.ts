// SPDX-License-Identifier: AGPL-3.0-only
// The SQL of the operator password reset. Wrangler runs a file without bound parameters, so
// every value is checked against a strict pattern before it enters the text.
import { passwordHashPattern } from '@flared/server/auth/password';

export const userIdPattern =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// Exactly one owner with exactly one password account, or the command stops.
export const ownerQuery = `SELECT u.id AS id, u.username AS username,
 (SELECT COUNT(*) FROM tenant_memberships WHERE role = 'owner') AS owners,
 (SELECT COUNT(*) FROM account WHERE providerId = 'credential') AS accounts
 FROM tenant_memberships m JOIN "user" u ON u.id = m.user_id WHERE m.role = 'owner'`;

export interface ResetInput {
	userId: string;
	passwordHash: string;
	auditId: string;
	now: number;
}

// Ends every credential of the owner, sets the new password, and ends sessions again, so a
// sign-in with the old password while the file runs keeps no session. Every statement is safe
// to repeat; setup, links, and analytics are untouched.
export function resetPasswordSql(input: ResetInput): string {
	const { userId, passwordHash, auditId, now } = input;
	if (
		!userIdPattern.test(userId) ||
		!passwordHashPattern.test(passwordHash) ||
		!userIdPattern.test(auditId) ||
		!Number.isSafeInteger(now) ||
		now < 0
	)
		throw new Error('Refusing to build the reset with an unexpected value');
	const user = `'${userId}'`;
	return [
		`DELETE FROM "session" WHERE userId = ${user};`,
		`DELETE FROM apikey WHERE referenceId = ${user};`,
		`DELETE FROM oauthAccessToken WHERE userId = ${user};`,
		`DELETE FROM oauthRefreshToken WHERE userId = ${user};`,
		`DELETE FROM oauthConsent WHERE userId = ${user};`,
		`DELETE FROM passkey WHERE userId = ${user};`,
		// Sign-in challenges and OAuth authorization codes; the owner is the only user.
		'DELETE FROM verification;',
		`UPDATE account SET password = '${passwordHash}', updatedAt = ${now} WHERE userId = ${user} AND providerId = 'credential';`,
		`DELETE FROM "session" WHERE userId = ${user};`,
		`INSERT INTO owner_audit (id, action, created_at) VALUES ('${auditId}', 'password_reset', ${now});`
	].join('\n');
}
