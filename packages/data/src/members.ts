// SPDX-License-Identifier: AGPL-3.0-only
// Identity-store records for a workspace's members and the invites that add them.
import type { D1Database, D1PreparedStatement, D1Result } from '@cloudflare/workers-types/index.ts';
import type { MembershipRole } from './tenancy';

export interface MemberRow {
	userId: string;
	email: string;
	// What the person signs in with: the username where there is one, else the email.
	name: string;
	role: MembershipRole;
	joinedAt: number;
}

export interface InviteRow {
	id: string;
	// null for an invite shared as a link.
	email: string | null;
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

export type MemberEventAction =
	| 'invite_sent'
	| 'invite_resent'
	| 'invite_cancelled'
	| 'invite_accepted'
	| 'member_removed'
	| 'member_left'
	| 'account_deleted'
	| 'transfer_offered'
	| 'transfer_withdrawn'
	| 'transfer_declined'
	| 'owner_changed'
	| 'password_reset_issued'
	| 'password_reset_used';

export const memberEventLifetimeMs = 90 * 86_400_000;

// The start of a statement that records a member event (see migration 0016). The row ID comes
// from SQLite, so one statement can record an event for each row it selects.
export const memberEventInsert = `INSERT INTO tenant_member_events
	(id, tenant_id, action, actor_user_id, subject_user_id, invite_id, created_at)
	SELECT lower(hex(randomblob(16))),`;

function role(value: unknown): MembershipRole {
	if (value !== 'owner' && value !== 'member') throw new Error('Invalid stored role');
	return value;
}

// The owner first, then members by the time they joined. The member limit bounds the read.
export async function listMembers(db: D1Database, tenantId: string): Promise<MemberRow[]> {
	const { results } = await db
		.prepare(
			`SELECT m.user_id, u.email, COALESCE(u."displayUsername", u.email) AS name, m.role, m.created_at
			FROM tenant_memberships m JOIN "user" u ON u.id = m.user_id
			WHERE m.tenant_id = ? ORDER BY m.role = 'owner' DESC, m.created_at, m.user_id LIMIT 100`
		)
		.bind(tenantId)
		.all<Record<string, unknown>>();
	return results.map((row) => ({
		userId: text(row.user_id, 'user'),
		email: text(row.email, 'email'),
		name: text(row.name, 'name'),
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
		email: row.email === null ? null : text(row.email, 'email'),
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
	// In lower case, or null for an invite shared as a link.
	email: string | null;
	tokenHash: string;
	invitedBy: string;
	now: number;
	expiresAt: number;
	// Replace an open invite for the same address with this token; a resend does this.
	renew: boolean;
}

// One statement checks the member limit and writes the invite, so two invites sent at once
// cannot both take the last place. An open invite for the same address counts once: a resend
// replaces its token and expiry and takes no new place. An invite without an address never
// conflicts, so each one takes a place.
export async function createInvite(db: D1Database, invite: NewInvite): Promise<InviteResult> {
	const { tenantId, email, now } = invite;
	const [written] = await db.batch<{ id: unknown }>([
		db
			.prepare(
				`INSERT INTO tenant_invites (id, tenant_id, email, token_hash, invited_by, created_at, expires_at)
			SELECT ?3, ?1, ?4, ?5, ?6, ?2, ?7 FROM tenant_policy p
			WHERE p.tenant_id = ?1
			AND NOT EXISTS (SELECT 1 FROM tenant_deletions WHERE tenant_id = ?1)
			AND NOT EXISTS (SELECT 1 FROM tenant_memberships m JOIN "user" u ON u.id = m.user_id WHERE m.tenant_id = ?1 AND lower(u.email) = ?4)
			AND (SELECT COUNT(*) FROM tenant_memberships WHERE tenant_id = ?1)
				+ (SELECT COUNT(*) FROM tenant_invites WHERE tenant_id = ?1 AND expires_at > ?2 AND email IS NOT ?4) < p.member_limit
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
			),
		// The token hash is new, so the event is recorded only when the invite was written.
		db
			.prepare(
				`${memberEventInsert} tenant_id, ?, ?, NULL, id, ? FROM tenant_invites WHERE token_hash = ?`
			)
			.bind(invite.renew ? 'invite_resent' : 'invite_sent', invite.invitedBy, now, invite.tokenHash)
	]);
	const row = written.results[0];
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

// The address of an invite of the workspace, open or expired, for a resend. null when there is
// none, or the invite was shared as a link.
export async function readInviteEmail(
	db: D1Database,
	tenantId: string,
	inviteId: string
): Promise<string | null> {
	const row = await db
		.prepare(
			'SELECT email FROM tenant_invites WHERE id = ? AND tenant_id = ? AND email IS NOT NULL'
		)
		.bind(inviteId, tenantId)
		.first<{ email: unknown }>();
	return row ? text(row.email, 'email') : null;
}

export async function cancelInvite(
	db: D1Database,
	input: { tenantId: string; inviteId: string; actorUserId: string; now: number }
): Promise<boolean> {
	const [, deleted] = await db.batch([
		db
			.prepare(
				`${memberEventInsert} tenant_id, 'invite_cancelled', ?3, NULL, id, ?4 FROM tenant_invites WHERE id = ?1 AND tenant_id = ?2`
			)
			.bind(input.inviteId, input.tenantId, input.actorUserId, input.now),
		db
			.prepare('DELETE FROM tenant_invites WHERE id = ? AND tenant_id = ?')
			.bind(input.inviteId, input.tenantId)
	]);
	return deleted.meta.changes === 1;
}

export interface InviteDetails {
	tenantId: string;
	workspaceName: string;
	email: string;
	expiresAt: number;
}

// An open invite for an address by its token hash, in a workspace that is active and not being
// deleted.
export async function readInvite(
	db: D1Database,
	tokenHash: string,
	now: number
): Promise<InviteDetails | null> {
	const row = await db
		.prepare(
			`SELECT i.tenant_id, t.name, i.email, i.expires_at FROM tenant_invites i
			JOIN tenants t ON t.id = i.tenant_id JOIN tenant_policy p ON p.tenant_id = i.tenant_id
			WHERE i.token_hash = ? AND i.email IS NOT NULL AND i.expires_at > ? AND t.activated_at IS NOT NULL
			AND p.suspended_at IS NULL AND NOT EXISTS (SELECT 1 FROM tenant_deletions d WHERE d.tenant_id = i.tenant_id)`
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

// One batch adds the membership, records it, and deletes the invite, so a token works once. The
// invite must be open and for the user's verified address. A second use finds no invite and is
// invalid.
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
		// Only a membership the first statement added has this join time.
		db
			.prepare(
				`${memberEventInsert} i.tenant_id, 'invite_accepted', ?2, ?2, i.id, ?3 ${open}
				AND EXISTS (SELECT 1 FROM tenant_memberships m WHERE m.tenant_id = i.tenant_id AND m.user_id = ?2 AND m.created_at = ?3)`
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

// Removes a member, never the owner, in one batch: the member's tokens and connected apps for
// the workspace, the session and sign-in pointers to it, an offer of the workspace to them, a
// password reset link, the event, then the membership. Every statement checks the member role first, so a batch for the
// owner changes nothing. The member's other workspaces and credentials stay. actorUserId is the
// owner who removes the member, or the member who leaves.
export async function removeMember(
	db: D1Database,
	input: { tenantId: string; userId: string; actorUserId: string; now: number }
): Promise<boolean> {
	const isMember =
		"EXISTS (SELECT 1 FROM tenant_memberships WHERE tenant_id = ?1 AND user_id = ?2 AND role = 'member')";
	const action: MemberEventAction =
		input.actorUserId === input.userId ? 'member_left' : 'member_removed';
	const results = await db.batch([
		...[
			`DELETE FROM "apikey" WHERE "referenceId" = ?2 AND json_extract("metadata", '$.tenantId') = ?1 AND ${isMember}`,
			`DELETE FROM "oauthAccessToken" WHERE "referenceId" = ?1 AND "userId" = ?2 AND ${isMember}`,
			`DELETE FROM "oauthRefreshToken" WHERE "referenceId" = ?1 AND "userId" = ?2 AND ${isMember}`,
			`DELETE FROM "oauthConsent" WHERE "referenceId" = ?1 AND "userId" = ?2 AND ${isMember}`,
			`DELETE FROM session_workspaces WHERE tenant_id = ?1 AND session_id IN (SELECT id FROM "session" WHERE "userId" = ?2) AND ${isMember}`,
			`DELETE FROM user_workspace_preferences WHERE user_id = ?2 AND tenant_id = ?1 AND ${isMember}`,
			`DELETE FROM tenant_transfers WHERE tenant_id = ?1 AND to_user_id = ?2 AND ${isMember}`,
			`DELETE FROM member_password_resets WHERE tenant_id = ?1 AND user_id = ?2 AND ${isMember}`
		].map((statement) => db.prepare(statement).bind(input.tenantId, input.userId)),
		db
			.prepare(`${memberEventInsert} ?1, ?3, ?4, ?2, NULL, ?5 WHERE ${isMember}`)
			.bind(input.tenantId, input.userId, action, input.actorUserId, input.now),
		db
			.prepare(
				"DELETE FROM tenant_memberships WHERE tenant_id = ?1 AND user_id = ?2 AND role = 'member'"
			)
			.bind(input.tenantId, input.userId)
	]);
	return results.at(-1)?.meta.changes === 1;
}

// The names of the workspaces the user owns that have other members, oldest first.
export async function ownedWorkspacesWithMembers(
	db: D1Database,
	userId: string
): Promise<string[]> {
	const { results } = await db
		.prepare(
			`SELECT t.name FROM tenant_memberships o JOIN tenants t ON t.id = o.tenant_id
			WHERE o.user_id = ? AND o.role = 'owner'
			AND EXISTS (SELECT 1 FROM tenant_memberships m WHERE m.tenant_id = o.tenant_id AND m.role = 'member')
			AND NOT EXISTS (SELECT 1 FROM tenant_deletions d WHERE d.tenant_id = o.tenant_id)
			ORDER BY o.created_at, o.tenant_id LIMIT 100`
		)
		.bind(userId)
		.all<{ name: unknown }>();
	return results.map((row) => text(row.name, 'name'));
}

export interface TransferOffer {
	// The member the owner offered the workspace to.
	userId: string;
	email: string;
	name: string;
	expiresAt: number;
}

// An offer counts only while its sender owns the workspace and its receiver is a member of it.
const openOffer = `FROM tenant_transfers x
	JOIN tenant_memberships o ON o.tenant_id = x.tenant_id AND o.user_id = x.from_user_id AND o.role = 'owner'
	JOIN tenant_memberships n ON n.tenant_id = x.tenant_id AND n.user_id = x.to_user_id AND n.role = 'member'`;

// The workspace's open offer of ownership, or null.
export async function readTransfer(
	db: D1Database,
	tenantId: string,
	now: number
): Promise<TransferOffer | null> {
	const row = await db
		.prepare(
			`SELECT x.to_user_id, u.email, COALESCE(u."displayUsername", u.email) AS name, x.expires_at
			${openOffer} JOIN "user" u ON u.id = x.to_user_id
			WHERE x.tenant_id = ? AND x.expires_at > ?`
		)
		.bind(tenantId, now)
		.first<Record<string, unknown>>();
	if (!row) return null;
	return {
		userId: text(row.to_user_id, 'user'),
		email: text(row.email, 'email'),
		name: text(row.name, 'name'),
		expiresAt: count(row.expires_at, 'expiry')
	};
}

// Records the owner's offer of the workspace to a member, in place of an earlier offer, and its
// event. False when the sender is not the owner, the receiver is not a member, or the workspace
// is being deleted.
export async function offerTransfer(
	db: D1Database,
	input: { tenantId: string; fromUserId: string; toUserId: string; now: number; expiresAt: number }
): Promise<boolean> {
	const [offered] = await db.batch([
		db
			.prepare(
				`INSERT INTO tenant_transfers (tenant_id, from_user_id, to_user_id, created_at, expires_at)
			SELECT ?1, ?2, ?3, ?4, ?5
			WHERE EXISTS (SELECT 1 FROM tenant_memberships WHERE tenant_id = ?1 AND user_id = ?2 AND role = 'owner')
			AND EXISTS (SELECT 1 FROM tenant_memberships WHERE tenant_id = ?1 AND user_id = ?3 AND role = 'member')
			AND NOT EXISTS (SELECT 1 FROM tenant_deletions WHERE tenant_id = ?1)
			ON CONFLICT (tenant_id) DO UPDATE SET from_user_id = excluded.from_user_id,
				to_user_id = excluded.to_user_id, created_at = excluded.created_at, expires_at = excluded.expires_at
			RETURNING tenant_id`
			)
			.bind(input.tenantId, input.fromUserId, input.toUserId, input.now, input.expiresAt),
		db
			.prepare(
				`${memberEventInsert} tenant_id, 'transfer_offered', from_user_id, to_user_id, NULL, created_at
				FROM tenant_transfers WHERE tenant_id = ?1 AND from_user_id = ?2 AND to_user_id = ?3 AND created_at = ?4`
			)
			.bind(input.tenantId, input.fromUserId, input.toUserId, input.now)
	]);
	return offered.results.length === 1;
}

// Ends the workspace's offer: the owner withdraws it, or the member it names declines it.
export async function cancelTransfer(
	db: D1Database,
	input: { tenantId: string; userId: string; owner: boolean; now: number }
): Promise<boolean> {
	const offer = `FROM tenant_transfers WHERE tenant_id = ?1 AND ${input.owner ? 'from_user_id' : 'to_user_id'} = ?2`;
	const action: MemberEventAction = input.owner ? 'transfer_withdrawn' : 'transfer_declined';
	const [, deleted] = await db.batch([
		db
			.prepare(`${memberEventInsert} tenant_id, ?3, ?2, to_user_id, NULL, ?4 ${offer}`)
			.bind(input.tenantId, input.userId, action, input.now),
		db.prepare(`DELETE ${offer}`).bind(input.tenantId, input.userId)
	]);
	return deleted.meta.changes === 1;
}

export interface TransferInput {
	tenantId: string;
	// The member who accepts the offer.
	toUserId: string;
	now: number;
}

// The statements that hand the workspace to the member its open offer names, for one batch. The
// first demotes the owner who made the offer, while the offer is open, the workspace is active,
// and condition holds. The second promotes the member only once the workspace has no owner, so
// the two happen together or not at all, and the one-owner index never sees two owners. The
// third records the event, with the previous owner from the offer, and the fourth deletes the
// offer. condition is SQL over the same parameters (?1 the tenant, ?2 the
// member, ?3 the time), so an edition adds its own rules to the same check; it is read once,
// before anything changes.
export function ownershipTransferStatements(
	db: D1Database,
	input: TransferInput,
	condition = '1'
): D1PreparedStatement[] {
	const open = `EXISTS (SELECT 1 ${openOffer} JOIN tenant_policy p ON p.tenant_id = x.tenant_id
		WHERE x.tenant_id = ?1 AND x.to_user_id = ?2 AND x.expires_at > ?3 AND p.suspended_at IS NULL
		AND NOT EXISTS (SELECT 1 FROM tenant_deletions d WHERE d.tenant_id = ?1)) AND (${condition})`;
	const { tenantId, toUserId, now } = input;
	return [
		db
			.prepare(
				`UPDATE tenant_memberships SET role = 'member' WHERE tenant_id = ?1 AND role = 'owner'
				AND user_id = (SELECT from_user_id FROM tenant_transfers WHERE tenant_id = ?1) AND ${open}`
			)
			.bind(tenantId, toUserId, now),
		db
			.prepare(
				`UPDATE tenant_memberships SET role = 'owner' WHERE tenant_id = ?1 AND user_id = ?2 AND role = 'member'
				AND NOT EXISTS (SELECT 1 FROM tenant_memberships WHERE tenant_id = ?1 AND role = 'owner')
				AND EXISTS (SELECT 1 FROM tenant_transfers WHERE tenant_id = ?1 AND to_user_id = ?2)`
			)
			.bind(tenantId, toUserId),
		db
			.prepare(
				`${memberEventInsert} tenant_id, 'owner_changed', ?2, from_user_id, NULL, ?3
				FROM tenant_transfers x WHERE tenant_id = ?1 AND to_user_id = ?2
				AND EXISTS (SELECT 1 FROM tenant_memberships WHERE tenant_id = ?1 AND user_id = ?2 AND role = 'owner')
				AND EXISTS (SELECT 1 FROM tenant_memberships WHERE tenant_id = ?1 AND user_id = x.from_user_id AND role = 'member')`
			)
			.bind(tenantId, toUserId, now),
		db
			.prepare(
				`DELETE FROM tenant_transfers WHERE tenant_id = ?1 AND to_user_id = ?2
				AND EXISTS (SELECT 1 FROM tenant_memberships WHERE tenant_id = ?1 AND user_id = ?2 AND role = 'owner')`
			)
			.bind(tenantId, toUserId)
	];
}

// True when the batch handed over the workspace: the promotion changed one row.
export function transferred(results: D1Result[], offset = 0): boolean {
	return results[offset + 1]?.meta.changes === 1;
}

export async function transferOwnership(db: D1Database, input: TransferInput): Promise<boolean> {
	return transferred(await db.batch(ownershipTransferStatements(db, input)));
}

export interface MemberEvent {
	id: string;
	action: MemberEventAction;
	actorUserId: string;
	// null when the account was deleted.
	actorEmail: string | null;
	subjectUserId: string | null;
	subjectEmail: string | null;
	inviteId: string | null;
	createdAt: number;
}

const memberEventActions: readonly MemberEventAction[] = [
	'invite_sent',
	'invite_resent',
	'invite_cancelled',
	'invite_accepted',
	'member_removed',
	'member_left',
	'account_deleted',
	'transfer_offered',
	'transfer_withdrawn',
	'transfer_declined',
	'owner_changed',
	'password_reset_issued',
	'password_reset_used'
];

function memberEventAction(value: unknown): MemberEventAction {
	const found = memberEventActions.find((action) => action === value);
	if (!found) throw new Error('Invalid stored member event');
	return found;
}

function textOrNull(value: unknown, field: string): string | null {
	return value === null ? null : text(value, field);
}

// The workspace's member events, newest first, with the current address of each person. Events
// of one millisecond keep the order of their writes (rowid).
export async function listMemberEvents(
	db: D1Database,
	tenantId: string,
	limit: number
): Promise<MemberEvent[]> {
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
		throw new Error('Invalid member event page size');
	const { results } = await db
		.prepare(
			`SELECT e.id, e.action, e.actor_user_id, a.email AS actor_email, e.subject_user_id,
			s.email AS subject_email, e.invite_id, e.created_at
			FROM tenant_member_events e LEFT JOIN "user" a ON a.id = e.actor_user_id
			LEFT JOIN "user" s ON s.id = e.subject_user_id
			WHERE e.tenant_id = ? ORDER BY e.created_at DESC, e.rowid DESC LIMIT ?`
		)
		.bind(tenantId, limit)
		.all<Record<string, unknown>>();
	return results.map((row) => ({
		id: text(row.id, 'member event'),
		action: memberEventAction(row.action),
		actorUserId: text(row.actor_user_id, 'user'),
		actorEmail: textOrNull(row.actor_email, 'email'),
		subjectUserId: textOrNull(row.subject_user_id, 'user'),
		subjectEmail: textOrNull(row.subject_email, 'email'),
		inviteId: textOrNull(row.invite_id, 'invite'),
		createdAt: count(row.created_at, 'event time')
	}));
}

// Removes member events older than memberEventLifetimeMs, at most limit rows per call.
export async function deleteExpiredMemberEvents(
	db: D1Database,
	now: number,
	limit: number
): Promise<{ deleted: number }> {
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000)
		throw new Error('Invalid purge batch size');
	const result = await db
		.prepare(
			'DELETE FROM tenant_member_events WHERE id IN (SELECT id FROM tenant_member_events WHERE created_at < ? LIMIT ?)'
		)
		.bind(now - memberEventLifetimeMs, limit)
		.run();
	return { deleted: result.meta.changes };
}

// An open invite shared as a link, in a workspace that is active and not being deleted. ?1 is the
// token hash and ?2 the time.
const openLinkInvite = `FROM tenant_invites i JOIN tenants t ON t.id = i.tenant_id
	JOIN tenant_policy p ON p.tenant_id = i.tenant_id
	WHERE i.token_hash = ?1 AND i.email IS NULL AND i.expires_at > ?2 AND t.activated_at IS NOT NULL
	AND p.suspended_at IS NULL AND NOT EXISTS (SELECT 1 FROM tenant_deletions d WHERE d.tenant_id = i.tenant_id)`;

export async function readLinkInvite(
	db: D1Database,
	tokenHash: string,
	now: number
): Promise<{ tenantId: string; workspaceName: string; expiresAt: number } | null> {
	const row = await db
		.prepare(`SELECT i.tenant_id, t.name, i.expires_at ${openLinkInvite}`)
		.bind(tokenHash, now)
		.first<Record<string, unknown>>();
	if (!row) return null;
	return {
		tenantId: text(row.tenant_id, 'tenant'),
		workspaceName: text(row.name, 'name'),
		expiresAt: count(row.expires_at, 'expiry')
	};
}

export interface NewMemberAccount {
	tokenHash: string;
	userId: string;
	// In lower case, and as the person typed it.
	username: string;
	displayUsername: string;
	// The account's internal address, never verified or sent to.
	email: string;
	accountId: string;
	passwordHash: string;
	now: number;
}

export type LinkAcceptResult =
	{ status: 'joined'; tenantId: string } | { status: 'invalid' } | { status: 'username_taken' };

// One batch creates the person's account, adds the membership, records it, and deletes the
// invite, so a link works once. Each statement checks that the invite is open and that the user
// row is the new one; a taken username stops the first statement, and so the whole batch.
export async function acceptLinkInvite(
	db: D1Database,
	input: NewMemberAccount
): Promise<LinkAcceptResult> {
	const { tokenHash, userId, now } = input;
	const created = 'EXISTS (SELECT 1 FROM "user" WHERE id = ?3 AND "createdAt" = ?2)';
	const [, , joined] = await db.batch([
		db
			.prepare(
				`INSERT INTO "user" (id, name, email, "emailVerified", username, "displayUsername", "createdAt", "updatedAt")
				SELECT ?3, ?5, ?6, 0, ?4, ?5, ?2, ?2 WHERE EXISTS (SELECT 1 ${openLinkInvite})
				AND NOT EXISTS (SELECT 1 FROM "user" WHERE username = ?4)`
			)
			.bind(tokenHash, now, userId, input.username, input.displayUsername, input.email),
		db
			.prepare(
				`INSERT INTO account (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt")
				SELECT ?4, ?3, 'credential', ?3, ?5, ?2, ?2 WHERE ${created}`
			)
			.bind(tokenHash, now, userId, input.accountId, input.passwordHash),
		db
			.prepare(
				`INSERT INTO tenant_memberships (tenant_id, user_id, role, created_at)
				SELECT i.tenant_id, ?3, 'member', ?2 ${openLinkInvite} AND ${created} RETURNING tenant_id`
			)
			.bind(tokenHash, now, userId),
		db
			.prepare(
				`${memberEventInsert} i.tenant_id, 'invite_accepted', ?3, ?3, i.id, ?2 ${openLinkInvite} AND ${created}`
			)
			.bind(tokenHash, now, userId),
		db
			.prepare(
				`DELETE FROM tenant_invites WHERE token_hash = ?1 AND email IS NULL
				AND EXISTS (SELECT 1 FROM tenant_memberships WHERE tenant_id = tenant_invites.tenant_id AND user_id = ?2)`
			)
			.bind(tokenHash, userId)
	]);
	const tenantId = (joined.results[0] as { tenant_id?: unknown } | undefined)?.tenant_id;
	if (typeof tenantId === 'string') return { status: 'joined', tenantId };
	return (await readLinkInvite(db, tokenHash, now))
		? { status: 'username_taken' }
		: { status: 'invalid' };
}

export const passwordResetLifetimeMs = 86_400_000;

// Records the owner's link that lets a member of the workspace set a new password, in place of
// an earlier one, and its event. False when the sender is not the owner, the person is not a
// member with a password, or the workspace is being deleted.
export async function createPasswordReset(
	db: D1Database,
	input: {
		tenantId: string;
		userId: string;
		createdBy: string;
		tokenHash: string;
		now: number;
		expiresAt: number;
	}
): Promise<boolean> {
	const [created] = await db.batch([
		db
			.prepare(
				`INSERT INTO member_password_resets (tenant_id, user_id, token_hash, created_by, created_at, expires_at)
				SELECT ?1, ?2, ?4, ?3, ?5, ?6
				WHERE EXISTS (SELECT 1 FROM tenant_memberships WHERE tenant_id = ?1 AND user_id = ?3 AND role = 'owner')
				AND EXISTS (SELECT 1 FROM tenant_memberships WHERE tenant_id = ?1 AND user_id = ?2 AND role = 'member')
				AND EXISTS (SELECT 1 FROM account WHERE "userId" = ?2 AND "providerId" = 'credential')
				AND NOT EXISTS (SELECT 1 FROM tenant_deletions WHERE tenant_id = ?1)
				ON CONFLICT (tenant_id, user_id) DO UPDATE SET token_hash = excluded.token_hash,
					created_by = excluded.created_by, created_at = excluded.created_at, expires_at = excluded.expires_at
				RETURNING user_id`
			)
			.bind(
				input.tenantId,
				input.userId,
				input.createdBy,
				input.tokenHash,
				input.now,
				input.expiresAt
			),
		db
			.prepare(
				`${memberEventInsert} tenant_id, 'password_reset_issued', created_by, user_id, NULL, created_at
				FROM member_password_resets WHERE token_hash = ?`
			)
			.bind(input.tokenHash)
	]);
	return created.results.length === 1;
}

// An open reset link: not expired, for a person who is still a member of a workspace that is
// not being deleted. ?1 is the token hash and ?2 the time.
const openReset = `FROM member_password_resets r JOIN tenants t ON t.id = r.tenant_id JOIN "user" u ON u.id = r.user_id
	JOIN tenant_memberships m ON m.tenant_id = r.tenant_id AND m.user_id = r.user_id AND m.role = 'member'
	WHERE r.token_hash = ?1 AND r.expires_at > ?2
	AND NOT EXISTS (SELECT 1 FROM tenant_deletions d WHERE d.tenant_id = r.tenant_id)`;

export async function readPasswordReset(
	db: D1Database,
	tokenHash: string,
	now: number
): Promise<{ userId: string; username: string; workspaceName: string; expiresAt: number } | null> {
	const row = await db
		.prepare(
			`SELECT r.user_id, COALESCE(u."displayUsername", u.username) AS username, t.name, r.expires_at ${openReset}`
		)
		.bind(tokenHash, now)
		.first<Record<string, unknown>>();
	if (!row) return null;
	return {
		userId: text(row.user_id, 'user'),
		username: text(row.username, 'username'),
		workspaceName: text(row.name, 'name'),
		expiresAt: count(row.expires_at, 'expiry')
	};
}

// One batch stores the new password hash, ends every session of the member, records the event,
// and deletes the link, so a link works once. API tokens and passkeys stay. Returns false, and
// changes nothing, when the link is not open.
export async function usePasswordReset(
	db: D1Database,
	input: { tokenHash: string; passwordHash: string; now: number }
): Promise<boolean> {
	const { tokenHash, now } = input;
	const member = `(SELECT r.user_id ${openReset})`;
	const [updated] = await db.batch([
		db
			.prepare(
				`UPDATE account SET password = ?3, "updatedAt" = ?2 WHERE "providerId" = 'credential' AND "userId" = ${member}`
			)
			.bind(tokenHash, now, input.passwordHash),
		db.prepare(`DELETE FROM "session" WHERE "userId" = ${member}`).bind(tokenHash, now),
		db
			.prepare(
				`${memberEventInsert} r.tenant_id, 'password_reset_used', r.user_id, r.user_id, NULL, ?2 ${openReset}`
			)
			.bind(tokenHash, now),
		db.prepare('DELETE FROM member_password_resets WHERE token_hash = ?').bind(tokenHash)
	]);
	return updated.meta.changes === 1;
}
