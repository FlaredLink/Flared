// SPDX-License-Identifier: AGPL-3.0-only
// Identity-store records for a workspace's members and the invites that add them.
import type { D1Database } from '@cloudflare/workers-types/index.ts';
import type { MembershipRole } from './tenancy';

export interface MemberRow {
	userId: string;
	email: string;
	role: MembershipRole;
	joinedAt: number;
}

export interface InviteRow {
	id: string;
	email: string;
	createdAt: number;
	expiresAt: number;
}

export interface MemberCount {
	// Members, and invites that have not expired.
	used: number;
	limit: number;
}

function text(value: unknown, field: string): string {
	if (typeof value !== 'string' || !value) throw new Error(`Invalid stored ${field}`);
	return value;
}

function count(value: unknown, field: string): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
		throw new Error(`Invalid stored ${field}`);
	return value;
}

function role(value: unknown): MembershipRole {
	if (value !== 'owner' && value !== 'member') throw new Error('Invalid stored role');
	return value;
}

// The owner first, then members by the time they joined. The member limit bounds the read.
export async function listMembers(db: D1Database, tenantId: string): Promise<MemberRow[]> {
	const { results } = await db
		.prepare(
			`SELECT m.user_id, u.email, m.role, m.created_at FROM tenant_memberships m JOIN "user" u ON u.id = m.user_id
			WHERE m.tenant_id = ? ORDER BY m.role = 'owner' DESC, m.created_at, m.user_id LIMIT 100`
		)
		.bind(tenantId)
		.all<Record<string, unknown>>();
	return results.map((row) => ({
		userId: text(row.user_id, 'user'),
		email: text(row.email, 'email'),
		role: role(row.role),
		joinedAt: count(row.created_at, 'join time')
	}));
}

// Open invites, newest first.
export async function listInvites(
	db: D1Database,
	tenantId: string,
	now: number
): Promise<InviteRow[]> {
	const { results } = await db
		.prepare(
			'SELECT id, email, created_at, expires_at FROM tenant_invites WHERE tenant_id = ? AND expires_at > ? ORDER BY created_at DESC, id LIMIT 100'
		)
		.bind(tenantId, now)
		.all<Record<string, unknown>>();
	return results.map((row) => ({
		id: text(row.id, 'invite'),
		email: text(row.email, 'email'),
		createdAt: count(row.created_at, 'invite time'),
		expiresAt: count(row.expires_at, 'expiry')
	}));
}

const usedSql = `(SELECT COUNT(*) FROM tenant_memberships WHERE tenant_id = ?1)
	+ (SELECT COUNT(*) FROM tenant_invites WHERE tenant_id = ?1 AND expires_at > ?2)`;

export async function readMemberCount(
	db: D1Database,
	tenantId: string,
	now: number
): Promise<MemberCount | null> {
	const row = await db
		.prepare(`SELECT ${usedSql} AS used, member_limit FROM tenant_policy WHERE tenant_id = ?1`)
		.bind(tenantId, now)
		.first<Record<string, unknown>>();
	if (!row) return null;
	return { used: count(row.used, 'member count'), limit: count(row.member_limit, 'member limit') };
}

// Counts one invite email for the workspace and UTC day. Returns false when the day's limit is
// already reached. Days before the previous one are removed.
export async function countInviteEmail(
	db: D1Database,
	tenantId: string,
	now: number,
	perDay: number
): Promise<boolean> {
	const day = Math.floor(now / 86_400_000);
	const [, row] = await db.batch<{ count: unknown }>([
		db
			.prepare('DELETE FROM tenant_invite_days WHERE tenant_id = ? AND day < ?')
			.bind(tenantId, day - 1),
		db
			.prepare(
				'INSERT INTO tenant_invite_days (tenant_id, day, count) VALUES (?, ?, 1) ON CONFLICT (tenant_id, day) DO UPDATE SET count = count + 1 RETURNING count'
			)
			.bind(tenantId, day)
	]);
	const sent = row.results[0]?.count;
	return typeof sent === 'number' && sent <= perDay;
}

export type InviteResult =
	| { status: 'invited'; id: string }
	| { status: 'member' }
	| { status: 'pending' }
	| { status: 'limit'; limit: number }
	| { status: 'no_workspace' };

export interface NewInvite {
	id: string;
	tenantId: string;
	// In lower case.
	email: string;
	tokenHash: string;
	invitedBy: string;
	now: number;
	expiresAt: number;
	// Replace an open invite for the same address with this token; a resend does this.
	renew: boolean;
}

// One statement checks the member limit and writes the invite, so two invites sent at once
// cannot both take the last place. An open invite for the same address counts once: a resend
// replaces its token and expiry and takes no new place.
export async function createInvite(db: D1Database, invite: NewInvite): Promise<InviteResult> {
	const { tenantId, email, now } = invite;
	const row = await db
		.prepare(
			`INSERT INTO tenant_invites (id, tenant_id, email, token_hash, invited_by, created_at, expires_at)
			SELECT ?3, ?1, ?4, ?5, ?6, ?2, ?7 FROM tenant_policy p
			WHERE p.tenant_id = ?1
			AND NOT EXISTS (SELECT 1 FROM tenant_deletions WHERE tenant_id = ?1)
			AND NOT EXISTS (SELECT 1 FROM tenant_memberships m JOIN "user" u ON u.id = m.user_id WHERE m.tenant_id = ?1 AND lower(u.email) = ?4)
			AND (SELECT COUNT(*) FROM tenant_memberships WHERE tenant_id = ?1)
				+ (SELECT COUNT(*) FROM tenant_invites WHERE tenant_id = ?1 AND expires_at > ?2 AND email <> ?4) < p.member_limit
			ON CONFLICT (tenant_id, email) DO UPDATE SET token_hash = excluded.token_hash,
				invited_by = excluded.invited_by, created_at = excluded.created_at, expires_at = excluded.expires_at
			WHERE ?8 = 1 OR tenant_invites.expires_at <= ?2
			RETURNING id`
		)
		.bind(
			tenantId,
			now,
			invite.id,
			email,
			invite.tokenHash,
			invite.invitedBy,
			invite.expiresAt,
			invite.renew ? 1 : 0
		)
		.first<{ id: unknown }>();
	if (row) return { status: 'invited', id: text(row.id, 'invite') };
	// Nothing was written; say why. The write above already kept the limit, so this read
	// cannot let an invite through.
	const state = await db
		.prepare(
			`SELECT p.member_limit,
			EXISTS (SELECT 1 FROM tenant_deletions WHERE tenant_id = ?1) AS deleting,
			EXISTS (SELECT 1 FROM tenant_memberships m JOIN "user" u ON u.id = m.user_id WHERE m.tenant_id = ?1 AND lower(u.email) = ?3) AS member,
			EXISTS (SELECT 1 FROM tenant_invites WHERE tenant_id = ?1 AND email = ?3 AND expires_at > ?2) AS pending
			FROM tenant_policy p WHERE p.tenant_id = ?1`
		)
		.bind(tenantId, now, email)
		.first<Record<string, unknown>>();
	if (!state || state.deleting === 1) return { status: 'no_workspace' };
	if (state.member === 1) return { status: 'member' };
	if (state.pending === 1 && !invite.renew) return { status: 'pending' };
	return { status: 'limit', limit: count(state.member_limit, 'member limit') };
}

// The address of an invite of the workspace, open or expired, for a resend.
export async function readInviteEmail(
	db: D1Database,
	tenantId: string,
	inviteId: string
): Promise<string | null> {
	const row = await db
		.prepare('SELECT email FROM tenant_invites WHERE id = ? AND tenant_id = ?')
		.bind(inviteId, tenantId)
		.first<{ email: unknown }>();
	return row ? text(row.email, 'email') : null;
}

export async function cancelInvite(
	db: D1Database,
	tenantId: string,
	inviteId: string
): Promise<boolean> {
	const result = await db
		.prepare('DELETE FROM tenant_invites WHERE id = ? AND tenant_id = ?')
		.bind(inviteId, tenantId)
		.run();
	return result.meta.changes === 1;
}

export interface InviteDetails {
	tenantId: string;
	workspaceName: string;
	email: string;
	expiresAt: number;
}

// An open invite by its token hash, in a workspace that is active and not being deleted.
export async function readInvite(
	db: D1Database,
	tokenHash: string,
	now: number
): Promise<InviteDetails | null> {
	const row = await db
		.prepare(
			`SELECT i.tenant_id, t.name, i.email, i.expires_at FROM tenant_invites i
			JOIN tenants t ON t.id = i.tenant_id JOIN tenant_policy p ON p.tenant_id = i.tenant_id
			WHERE i.token_hash = ? AND i.expires_at > ? AND t.activated_at IS NOT NULL AND p.suspended_at IS NULL
			AND NOT EXISTS (SELECT 1 FROM tenant_deletions d WHERE d.tenant_id = i.tenant_id)`
		)
		.bind(tokenHash, now)
		.first<Record<string, unknown>>();
	if (!row) return null;
	return {
		tenantId: text(row.tenant_id, 'tenant'),
		workspaceName: text(row.name, 'name'),
		email: text(row.email, 'email'),
		expiresAt: count(row.expires_at, 'expiry')
	};
}

export type AcceptResult =
	| { status: 'joined'; tenantId: string }
	| { status: 'invalid' }
	| { status: 'other_email'; email: string };

// One batch adds the membership and deletes the invite, so a token works once. The invite must
// be open and for the user's verified address. A second use finds no invite and is invalid.
export async function acceptInvite(
	db: D1Database,
	input: { tokenHash: string; userId: string; now: number }
): Promise<AcceptResult> {
	const { tokenHash, userId, now } = input;
	const open = `FROM tenant_invites i JOIN tenants t ON t.id = i.tenant_id JOIN tenant_policy p ON p.tenant_id = i.tenant_id
		JOIN "user" u ON u.id = ?2 AND u."emailVerified" = 1 AND lower(u.email) = i.email
		WHERE i.token_hash = ?1 AND i.expires_at > ?3 AND t.activated_at IS NOT NULL AND p.suspended_at IS NULL
		AND NOT EXISTS (SELECT 1 FROM tenant_deletions d WHERE d.tenant_id = i.tenant_id)`;
	const [joined] = await db.batch([
		db
			.prepare(
				`INSERT INTO tenant_memberships (tenant_id, user_id, role, created_at)
				SELECT i.tenant_id, ?2, 'member', ?3 ${open} ON CONFLICT (tenant_id, user_id) DO NOTHING RETURNING tenant_id`
			)
			.bind(tokenHash, userId, now),
		db
			.prepare(
				`DELETE FROM tenant_invites WHERE token_hash = ?1 AND EXISTS (SELECT 1 ${open})
				AND EXISTS (SELECT 1 FROM tenant_memberships m WHERE m.tenant_id = tenant_invites.tenant_id AND m.user_id = ?2)`
			)
			.bind(tokenHash, userId, now)
	]);
	const tenantId = (joined.results[0] as { tenant_id?: unknown } | undefined)?.tenant_id;
	if (typeof tenantId === 'string') return { status: 'joined', tenantId };
	// The invite is still open, so it is for another address or an unverified one.
	const invite = await readInvite(db, tokenHash, now);
	return invite ? { status: 'other_email', email: invite.email } : { status: 'invalid' };
}
