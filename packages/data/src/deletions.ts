// SPDX-License-Identifier: AGPL-3.0-only
// Workspace deletion records and the bounded deletes of each store. Every function is safe to
// repeat, so a deletion job that stops can resume at its step.
import type { D1Database } from '@cloudflare/workers-types/index.ts';

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

export interface DeletionJob {
	tenantId: string;
	userId: string;
	analyticsShardId: string;
	contactEmail: string | null;
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
	return {
		tenantId: text(row.tenant_id, 'tenant'),
		userId: text(row.user_id, 'user'),
		analyticsShardId: text(row.analytics_shard_id, 'shard'),
		contactEmail: row.contact_email === null ? null : text(row.contact_email, 'contact'),
		step,
		requestedAt: count(row.requested_at, 'request time'),
		routesStoppedAt:
			row.routes_stopped_at === null ? null : count(row.routes_stopped_at, 'stop time'),
		attempts: count(row.attempts, 'attempts')
	};
}

const jobColumns =
	'tenant_id, user_id, analytics_shard_id, contact_email, step, requested_at, routes_stopped_at, attempts';

// One batch: the job; every API token and connected app bound to the workspace; and, when it is
// the user's last workspace, the user's sessions and remaining credentials. Nothing can act for
// the workspace once the request returns. Returns false when a deletion already exists or the
// operator suspended the tenant; a suspended tenant keeps its credentials too.
export async function createDeletion(
	db: D1Database,
	request: {
		tenantId: string;
		userId: string;
		analyticsShardId: string;
		contactEmail: string | null;
		now: number;
	}
): Promise<boolean> {
	const { tenantId, userId, now } = request;
	const hasJob = 'EXISTS (SELECT 1 FROM tenant_deletions WHERE tenant_id = ?1)';
	const lastWorkspace =
		'NOT EXISTS (SELECT 1 FROM tenant_memberships WHERE user_id = ?2 AND tenant_id <> ?1)';
	const [job] = await db.batch([
		db
			.prepare(
				"INSERT INTO tenant_deletions (tenant_id, user_id, analytics_shard_id, contact_email, state, step, requested_at, next_attempt_at) SELECT ?1, ?2, ?3, ?4, 'running', 'accepted', ?5, ?5 WHERE NOT EXISTS (SELECT 1 FROM tenant_policy WHERE tenant_id = ?1 AND suspended_at IS NOT NULL) ON CONFLICT (tenant_id) DO NOTHING"
			)
			.bind(tenantId, userId, request.analyticsShardId, request.contactEmail, now),
		...[
			`DELETE FROM "apikey" WHERE json_extract("metadata", '$.tenantId') = ?1`,
			'DELETE FROM "oauthAccessToken" WHERE "referenceId" = ?1',
			'DELETE FROM "oauthRefreshToken" WHERE "referenceId" = ?1',
			'DELETE FROM "oauthConsent" WHERE "referenceId" = ?1'
		].map((statement) => db.prepare(`${statement} AND ${hasJob}`).bind(tenantId)),
		...[
			'DELETE FROM "session" WHERE "userId" = ?2',
			'DELETE FROM "apikey" WHERE "referenceId" = ?2',
			'DELETE FROM "oauthAccessToken" WHERE "userId" = ?2',
			'DELETE FROM "oauthRefreshToken" WHERE "userId" = ?2',
			'DELETE FROM "oauthConsent" WHERE "userId" = ?2'
		].map((statement) =>
			db.prepare(`${statement} AND ${lastWorkspace} AND ${hasJob}`).bind(tenantId, userId)
		)
	]);
	return job.meta.changes === 1;
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

// The end of the job: the ledger row keeps no contact.
export async function completeDeletion(
	db: D1Database,
	tenantId: string,
	now: number
): Promise<void> {
	await db
		.prepare(
			"UPDATE tenant_deletions SET state = 'completed', step = 'done', contact_email = NULL, completed_at = ?, last_error_code = NULL WHERE tenant_id = ? AND state = 'running'"
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
