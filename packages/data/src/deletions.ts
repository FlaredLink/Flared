// SPDX-License-Identifier: AGPL-3.0-only
// Workspace deletion records and the bounded deletes of each store. Every function is safe to
// repeat, so a deletion job that stops can resume at its step.
import type { D1Database } from '@cloudflare/workers-types/index.ts';
import { memberEventInsert } from './members';

export const deletionSteps = [
	'accepted',
	'routing',
	'wait',
	'analytics',
	'routing_data',
	'extension',
	'identity',
	'completed_notice',
	'done'
] as const;
export type DeletionStep = (typeof deletionSteps)[number];

export type DeletionScope = 'account' | 'workspace';

export interface DeletionJob {
	tenantId: string;
	userId: string;
	analyticsShardId: string;
	contactEmail: string | null;
	scope: DeletionScope;
	// Set for a workspace deletion, so its emails name the workspace.
	workspaceName: string | null;
	step: DeletionStep;
	requestedAt: number;
	routesStoppedAt: number | null;
	attempts: number;
}

// Completed rows stay this long as the deletion ledger, as tombstones do on the shards.
export const deletionRecordLifetimeMs = 90 * 86400000;

function text(value: unknown, field: string): string {
	if (typeof value !== 'string' || !value) throw new Error(`Invalid stored ${field}`);
	return value;
}

function count(value: unknown, field: string): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
		throw new Error(`Invalid stored ${field}`);
	return value;
}

function toJob(row: Record<string, unknown>): DeletionJob {
	const step = deletionSteps.find((name) => name === row.step);
	if (!step) throw new Error('Invalid stored deletion step');
	if (row.scope !== 'account' && row.scope !== 'workspace')
		throw new Error('Invalid stored deletion scope');
	return {
		tenantId: text(row.tenant_id, 'tenant'),
		userId: text(row.user_id, 'user'),
		analyticsShardId: text(row.analytics_shard_id, 'shard'),
		contactEmail: row.contact_email === null ? null : text(row.contact_email, 'contact'),
		scope: row.scope,
		workspaceName: row.workspace_name === null ? null : text(row.workspace_name, 'name'),
		step,
		requestedAt: count(row.requested_at, 'request time'),
		routesStoppedAt:
			row.routes_stopped_at === null ? null : count(row.routes_stopped_at, 'stop time'),
		attempts: count(row.attempts, 'attempts')
	};
}

const jobColumns =
	'tenant_id, user_id, analytics_shard_id, contact_email, scope, workspace_name, step, requested_at, routes_stopped_at, attempts';

// The tokens, connected apps, and MCP access bound to the workspace. Each statement runs only
// when the batch created or found the workspace's job.
const tenantCredentials = [
	`DELETE FROM "apikey" WHERE json_extract("metadata", '$.tenantId') = ?1`,
	'DELETE FROM "oauthAccessToken" WHERE "referenceId" = ?1',
	'DELETE FROM "oauthRefreshToken" WHERE "referenceId" = ?1',
	'DELETE FROM "oauthConsent" WHERE "referenceId" = ?1'
];

const notSuspended = (tenant: string) =>
	`NOT EXISTS (SELECT 1 FROM tenant_policy WHERE tenant_id = ${tenant} AND suspended_at IS NOT NULL)`;
const hasJob = (tenant: string) =>
	`EXISTS (SELECT 1 FROM tenant_deletions WHERE tenant_id = ${tenant})`;

export interface WorkspaceDeletionRequest {
	tenantId: string;
	userId: string;
	analyticsShardId: string;
	workspaceName: string;
	contactEmail: string | null;
	now: number;
}

// One batch: the job and every credential bound to the workspace. The user keeps the account,
// the sessions, and the other workspaces, so the batch needs another workspace of the user that
// is not being deleted. Returns false when that is missing, a deletion already exists, or the
// operator suspended the tenant; nothing changes then.
export async function createWorkspaceDeletion(
	db: D1Database,
	request: WorkspaceDeletionRequest
): Promise<boolean> {
	const { tenantId, userId, now } = request;
	const otherWorkspace =
		'EXISTS (SELECT 1 FROM tenant_memberships m WHERE m.user_id = ?2 AND m.tenant_id <> ?1 AND NOT EXISTS (SELECT 1 FROM tenant_deletions d WHERE d.tenant_id = m.tenant_id))';
	const [job] = await db.batch([
		db
			.prepare(
				`INSERT INTO tenant_deletions (tenant_id, user_id, analytics_shard_id, contact_email, scope, workspace_name, state, step, requested_at, next_attempt_at) SELECT ?1, ?2, ?3, ?4, 'workspace', ?5, 'running', 'accepted', ?6, ?6 WHERE ${notSuspended('?1')} AND ${otherWorkspace} ON CONFLICT (tenant_id) DO NOTHING`
			)
			.bind(
				tenantId,
				userId,
				request.analyticsShardId,
				request.contactEmail,
				request.workspaceName,
				now
			),
		...tenantCredentials.map((statement) =>
			db.prepare(`${statement} AND ${hasJob('?1')}`).bind(tenantId)
		)
	]);
	return job.meta.changes === 1;
}

export interface AccountDeletionRequest {
	userId: string;
	// The workspaces the user owns that are not being deleted yet. The first job sends the
	// emails, so contactEmail is stored with it only.
	workspaces: { tenantId: string; analyticsShardId: string }[];
	contactEmail: string | null;
	now: number;
}

// One batch: a job for each workspace, their credentials, the user's sessions and remaining
// credentials, and the user's memberships in workspaces of other owners. Nothing can act for
// the account once the request returns. All jobs start, or none: a suspended workspace stops
// the whole batch and keeps every credential. Returns whether the batch started a job; false
// when a workspace is suspended or another request started every job first.
export async function createAccountDeletion(
	db: D1Database,
	request: AccountDeletionRequest
): Promise<boolean> {
	const { userId, workspaces, now } = request;
	const [first] = workspaces;
	if (!first) return false;
	const tenants = workspaces.map((workspace) => workspace.tenantId);
	// ?1 is the user; ?2 to ?n+1 are the workspaces.
	const list = tenants.map((_, index) => `?${index + 2}`).join(', ');
	const noneSuspended = `NOT EXISTS (SELECT 1 FROM tenant_policy WHERE tenant_id IN (${list}) AND suspended_at IS NOT NULL)`;
	const results = await db.batch([
		...workspaces.map((workspace, index) =>
			db
				.prepare(
					`INSERT INTO tenant_deletions (tenant_id, user_id, analytics_shard_id, contact_email, scope, state, step, requested_at, next_attempt_at) SELECT ?${tenants.length + 2}, ?1, ?${tenants.length + 3}, ?${tenants.length + 4}, 'account', 'running', 'accepted', ?${tenants.length + 5}, ?${tenants.length + 5} WHERE ${noneSuspended} ON CONFLICT (tenant_id) DO NOTHING`
				)
				.bind(
					userId,
					...tenants,
					workspace.tenantId,
					workspace.analyticsShardId,
					index === 0 ? request.contactEmail : null,
					now
				)
		),
		...workspaces.flatMap((workspace) =>
			tenantCredentials.map((statement) =>
				db.prepare(`${statement} AND ${hasJob('?1')}`).bind(workspace.tenantId)
			)
		),
		db
			.prepare(
				`${memberEventInsert} tenant_id, 'account_deleted', ?1, ?1, NULL, ?3 FROM tenant_memberships WHERE user_id = ?1 AND role <> 'owner' AND ${hasJob('?2')}`
			)
			.bind(userId, first.tenantId, now),
		...[
			'DELETE FROM "session" WHERE "userId" = ?1',
			'DELETE FROM "apikey" WHERE "referenceId" = ?1',
			'DELETE FROM "oauthAccessToken" WHERE "userId" = ?1',
			'DELETE FROM "oauthRefreshToken" WHERE "userId" = ?1',
			'DELETE FROM "oauthConsent" WHERE "userId" = ?1',
			"DELETE FROM tenant_memberships WHERE user_id = ?1 AND role <> 'owner'"
		].map((statement) =>
			db.prepare(`${statement} AND ${hasJob('?2')}`).bind(userId, first.tenantId)
		)
	]);
	return results.slice(0, workspaces.length).some((result) => result.meta.changes === 1);
}

// Whether an account deletion of the user is running. The user can sign in again until the
// last job ends, but cannot start a new workspace.
export async function accountDeletionRunning(db: D1Database, userId: string): Promise<boolean> {
	return (
		(await db
			.prepare(
				"SELECT 1 AS found FROM tenant_deletions WHERE user_id = ? AND state = 'running' AND scope = 'account' LIMIT 1"
			)
			.bind(userId)
			.first()) !== null
	);
}

export async function readDeletion(db: D1Database, tenantId: string): Promise<DeletionJob | null> {
	const row = await db
		.prepare(`SELECT ${jobColumns} FROM tenant_deletions WHERE tenant_id = ? AND state = 'running'`)
		.bind(tenantId)
		.first<Record<string, unknown>>();
	return row ? toJob(row) : null;
}

// Claims due jobs, or one tenant's job. The claim moves next_attempt_at forward by 1, 2, 4, ...
// minutes (at most about 8.5 hours), so a run that fails waits longer each time and two runners
// never hold one job at once.
export async function claimDeletions(
	db: D1Database,
	now: number,
	limit: number,
	tenantId: string | null = null
): Promise<DeletionJob[]> {
	const { results } = await db
		.prepare(
			`UPDATE tenant_deletions SET attempts = attempts + 1, next_attempt_at = ? + (60000 << min(attempts, 9)) WHERE tenant_id IN (SELECT tenant_id FROM tenant_deletions WHERE state = 'running' AND next_attempt_at <= ?${tenantId ? ' AND tenant_id = ?' : ''} ORDER BY next_attempt_at LIMIT ?) RETURNING ${jobColumns}`
		)
		.bind(now, now, ...(tenantId ? [tenantId] : []), limit)
		.all<Record<string, unknown>>();
	return results.map(toJob);
}

// Records progress, so failures count from here. next is when the job runs again; without it
// the claim's backoff stays, which applies if a later step of this run fails.
export async function saveDeletion(
	db: D1Database,
	tenantId: string,
	change: { step: DeletionStep; next?: number; routesStoppedAt?: number }
): Promise<void> {
	await db
		.prepare(
			"UPDATE tenant_deletions SET step = ?, next_attempt_at = COALESCE(?, next_attempt_at), attempts = 0, last_error_code = NULL, routes_stopped_at = COALESCE(?, routes_stopped_at) WHERE tenant_id = ? AND state = 'running'"
		)
		.bind(change.step, change.next ?? null, change.routesStoppedAt ?? null, tenantId)
		.run();
}

export async function failDeletion(db: D1Database, tenantId: string, code: string): Promise<void> {
	await db
		.prepare('UPDATE tenant_deletions SET last_error_code = ? WHERE tenant_id = ?')
		.bind(code, tenantId)
		.run();
}

// The end of the job: the ledger row keeps no contact and no workspace name.
export async function completeDeletion(
	db: D1Database,
	tenantId: string,
	now: number
): Promise<void> {
	await db
		.prepare(
			"UPDATE tenant_deletions SET state = 'completed', step = 'done', contact_email = NULL, workspace_name = NULL, completed_at = ?, last_error_code = NULL WHERE tenant_id = ? AND state = 'running'"
		)
		.bind(now, tenantId)
		.run();
}

export async function deleteExpiredDeletions(db: D1Database, now: number): Promise<number> {
	const result = await db
		.prepare(
			"DELETE FROM tenant_deletions WHERE tenant_id IN (SELECT tenant_id FROM tenant_deletions WHERE state = 'completed' AND completed_at < ? LIMIT 1000)"
		)
		.bind(now - deletionRecordLifetimeMs)
		.run();
	return result.meta.changes;
}

// Routing: without its policy row, no link of the tenant redirects.
export async function deleteRoutingPolicy(db: D1Database, tenantId: string): Promise<void> {
	await db.prepare('DELETE FROM tenant_policy WHERE tenant_id = ?').bind(tenantId).run();
}

// Deletes up to limit links and the tenant's request records. Slug reservations, hostname
// namespaces, and disabled domain rows stay, so no address can be reused. Returns the rows
// deleted; 0 means nothing is left.
export async function deleteRoutingData(
	db: D1Database,
	tenantId: string,
	limit: number
): Promise<number> {
	const results = await db.batch([
		db
			.prepare('DELETE FROM links WHERE id IN (SELECT id FROM links WHERE tenant_id = ? LIMIT ?)')
			.bind(tenantId, limit),
		db
			.prepare(
				'DELETE FROM idempotency_records WHERE rowid IN (SELECT rowid FROM idempotency_records WHERE tenant_id = ? LIMIT ?)'
			)
			.bind(tenantId, limit),
		// Domain additions count under "<tenant>:domains".
		db
			.prepare('DELETE FROM creation_windows WHERE tenant_id IN (?, ?)')
			.bind(tenantId, `${tenantId}:domains`)
	]);
	return results.reduce((sum, result) => sum + result.meta.changes, 0);
}

// Analytics shard: the tombstone and the end of the shard's policy in one batch, so a late click
// is dropped from then on.
export async function tombstoneTenant(
	db: D1Database,
	tenantId: string,
	now: number
): Promise<void> {
	await db.batch([
		db
			.prepare(
				'INSERT INTO tenant_tombstones (tenant_id, deleted_at) VALUES (?, ?) ON CONFLICT (tenant_id) DO NOTHING'
			)
			.bind(tenantId, now),
		db.prepare('DELETE FROM tenant_policy WHERE tenant_id = ?').bind(tenantId)
	]);
}

export async function isTombstoned(db: D1Database, tenantId: string): Promise<boolean> {
	return (
		(await db
			.prepare('SELECT 1 AS found FROM tenant_tombstones WHERE tenant_id = ?')
			.bind(tenantId)
			.first()) !== null
	);
}

// Deletes up to limit rows of each analytics table. Returns the rows deleted.
export async function deleteAnalyticsData(
	db: D1Database,
	tenantId: string,
	limit: number
): Promise<number> {
	const byRowid = (table: string) =>
		db
			.prepare(
				`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE tenant_id = ? LIMIT ?)`
			)
			.bind(tenantId, limit);
	const results = await db.batch([
		byRowid('daily_totals'),
		byRowid('daily_dimensions'),
		byRowid('monthly_usage'),
		db
			.prepare(
				'DELETE FROM event_receipts WHERE (tenant_id, event_id) IN (SELECT tenant_id, event_id FROM event_receipts WHERE tenant_id = ? LIMIT ?)'
			)
			.bind(tenantId, limit)
	]);
	return results.reduce((sum, result) => sum + result.meta.changes, 0);
}

// Whether the user row is still there: the last job of an account deletes it.
export async function userRemains(db: D1Database, userId: string): Promise<boolean> {
	return (
		(await db.prepare('SELECT 1 AS found FROM "user" WHERE "id" = ?').bind(userId).first()) !== null
	);
}

// Identity: everything of the tenant and its user in one batch. The user's sessions, passkeys,
// accounts, tokens, and connected apps go with the user row. A single-workspace installation
// closes.
export async function deleteIdentityRecords(
	db: D1Database,
	tenantId: string,
	userId: string,
	now: number
): Promise<void> {
	await db.batch([
		db.prepare('DELETE FROM notices WHERE tenant_id = ?').bind(tenantId),
		db.prepare('DELETE FROM tenant_policy WHERE tenant_id = ?').bind(tenantId),
		db.prepare('DELETE FROM tenant_memberships WHERE tenant_id = ?').bind(tenantId),
		db
			.prepare(
				'DELETE FROM "user" WHERE "id" = ? AND NOT EXISTS (SELECT 1 FROM tenant_memberships WHERE user_id = ?)'
			)
			.bind(userId, userId),
		db.prepare('DELETE FROM tenants WHERE id = ?').bind(tenantId),
		db
			.prepare(
				"UPDATE installation SET closed_at = ? WHERE id = 1 AND mode = 'single' AND closed_at IS NULL"
			)
			.bind(now)
	]);
}

// Deletes a user who owns no workspace: their memberships with an event in each workspace, then
// the user row, whose sessions, passkeys, tokens, and connected apps go with it. Returns false,
// and changes nothing, when the user owns a workspace.
export async function deleteMemberOnlyUser(
	db: D1Database,
	userId: string,
	now: number
): Promise<boolean> {
	const ownsNone =
		"NOT EXISTS (SELECT 1 FROM tenant_memberships WHERE user_id = ?1 AND role = 'owner')";
	const [, , user] = await db.batch([
		db
			.prepare(
				`${memberEventInsert} tenant_id, 'account_deleted', ?1, ?1, NULL, ?2 FROM tenant_memberships WHERE user_id = ?1 AND role = 'member' AND ${ownsNone}`
			)
			.bind(userId, now),
		db
			.prepare(
				`DELETE FROM tenant_memberships WHERE user_id = ?1 AND role = 'member' AND ${ownsNone}`
			)
			.bind(userId),
		db
			.prepare(
				'DELETE FROM "user" WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM tenant_memberships WHERE user_id = ?1)'
			)
			.bind(userId)
	]);
	// D1 counts the rows the user's deletion removes in other tables too.
	return user.meta.changes > 0;
}
