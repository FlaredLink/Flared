// SPDX-License-Identifier: AGPL-3.0-only
// Identity-store records for the installation, tenants, owner memberships, and source policy.
import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types/index.ts';
import { isBlockReason, type BlockReason } from '@flared/contracts/links';

export type InstallationMode = 'single' | 'multi';

export interface PolicyLimits {
	activeLinkLimit: number;
	monthlyClickLimit: number;
	retentionDays: number;
	domainLimit: number;
}

export interface NewTenant {
	id: string;
	name: string;
	ownerUserId: string;
	analyticsShardId: string;
	limits: PolicyLimits;
	now: number;
}

export interface Membership {
	tenantId: string;
	activated: boolean;
	// A deletion of the tenant has started.
	deleting: boolean;
	// The operator suspended the tenant, with the abuse category the owner sees.
	suspension: { reason: BlockReason } | null;
}

export interface PolicyProjection {
	tenantId: string;
	revision: number;
	routingRevision: number;
	analyticsRevision: number;
	analyticsShardId: string;
	activeLinkLimit: number;
	domainLimit: number;
	monthlyClickLimit: number;
	retentionDays: number;
	suspendedAt: number | null;
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

function reason(value: unknown): BlockReason {
	if (!isBlockReason(value)) throw new Error('Invalid stored suspension reason');
	return value;
}

function checkLimits(limits: PolicyLimits): void {
	for (const value of Object.values(limits))
		if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid policy limits');
	if (limits.retentionDays < 1) throw new Error('Invalid policy limits');
}

export async function readInstallationMode(db: D1Database): Promise<InstallationMode | null> {
	const row = await db
		.prepare('SELECT mode FROM installation WHERE id = 1')
		.first<{ mode: unknown }>();
	if (!row) return null;
	if (row.mode !== 'single' && row.mode !== 'multi') throw new Error('Invalid stored mode');
	return row.mode;
}

// Returns at most two rows: a second membership is a provisioning error the caller reports.
export async function listMemberships(db: D1Database, userId: string): Promise<Membership[]> {
	const { results } = await db
		.prepare(
			'SELECT m.tenant_id, t.activated_at, EXISTS (SELECT 1 FROM tenant_deletions d WHERE d.tenant_id = m.tenant_id) AS deleting, p.suspended_at, p.suspended_reason FROM tenant_memberships m JOIN tenants t ON t.id = m.tenant_id LEFT JOIN tenant_policy p ON p.tenant_id = m.tenant_id WHERE m.user_id = ? ORDER BY m.created_at, m.tenant_id LIMIT 2'
		)
		.bind(userId)
		.all<Record<string, unknown>>();
	return results.map((row) => ({
		tenantId: text(row.tenant_id, 'tenant'),
		activated: row.activated_at !== null,
		deleting: row.deleting === 1,
		suspension: row.suspended_at === null ? null : { reason: reason(row.suspended_reason) }
	}));
}

// One batch: a database guard (missing installation, single mode, one workspace per user)
// rejects the whole tenant, so no partial tenant is left behind.
export async function createTenant(db: D1Database, tenant: NewTenant): Promise<void> {
	await db.batch(tenantStatements(db, tenant));
}

// The statements of createTenant, for a caller that commits them with its own records.
export function tenantStatements(db: D1Database, tenant: NewTenant): D1PreparedStatement[] {
	checkLimits(tenant.limits);
	const { limits, now } = tenant;
	return [
		db
			.prepare('INSERT INTO tenants (id, name, analytics_shard_id, created_at) VALUES (?, ?, ?, ?)')
			.bind(tenant.id, tenant.name, tenant.analyticsShardId, now),
		db
			.prepare(
				"INSERT INTO tenant_memberships (tenant_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)"
			)
			.bind(tenant.id, tenant.ownerUserId, now),
		db
			.prepare(
				'INSERT INTO tenant_policy (tenant_id, revision, active_link_limit, monthly_click_limit, retention_days, domain_limit, updated_at) VALUES (?, 1, ?, ?, ?, ?, ?)'
			)
			.bind(
				tenant.id,
				limits.activeLinkLimit,
				limits.monthlyClickLimit,
				limits.retentionDays,
				limits.domainLimit,
				now
			)
	];
}

// Replaces the limits and takes the next revision in one statement, so concurrent updates each
// get their own revision and the newest one wins in every store. Returns null for no tenant, or
// for a tenant whose deletion has started.
export async function updateTenantPolicy(
	db: D1Database,
	tenantId: string,
	limits: PolicyLimits,
	now: number
): Promise<number | null> {
	checkLimits(limits);
	const row = await db
		.prepare(
			'UPDATE tenant_policy SET revision = revision + 1, active_link_limit = ?, monthly_click_limit = ?, retention_days = ?, domain_limit = ?, updated_at = ? WHERE tenant_id = ?6 AND NOT EXISTS (SELECT 1 FROM tenant_deletions WHERE tenant_id = ?6) RETURNING revision'
		)
		.bind(
			limits.activeLinkLimit,
			limits.monthlyClickLimit,
			limits.retentionDays,
			limits.domainLimit,
			now,
			tenantId
		)
		.first<{ revision: unknown }>();
	return row ? count(row.revision, 'revision') : null;
}

export async function readTenantShard(db: D1Database, tenantId: string): Promise<string | null> {
	const row = await db
		.prepare('SELECT analytics_shard_id FROM tenants WHERE id = ?')
		.bind(tenantId)
		.first<{ analytics_shard_id: unknown }>();
	return row ? text(row.analytics_shard_id, 'shard') : null;
}

export async function readTenantName(db: D1Database, tenantId: string): Promise<string | null> {
	const row = await db
		.prepare('SELECT name FROM tenants WHERE id = ?')
		.bind(tenantId)
		.first<{ name: unknown }>();
	return row ? text(row.name, 'name') : null;
}

// The caller validates the name. Returns false when the tenant does not exist.
export async function renameTenant(
	db: D1Database,
	tenantId: string,
	name: string
): Promise<boolean> {
	const result = await db
		.prepare('UPDATE tenants SET name = ? WHERE id = ?')
		.bind(name, tenantId)
		.run();
	return result.meta.changes === 1;
}

// Null also for a tenant whose deletion has started: no store may receive its policy again.
export async function readPolicyProjection(
	db: D1Database,
	tenantId: string
): Promise<PolicyProjection | null> {
	const row = await db
		.prepare(
			'SELECT p.revision, p.routing_revision, p.analytics_revision, t.analytics_shard_id, p.active_link_limit, p.domain_limit, p.monthly_click_limit, p.retention_days, p.suspended_at FROM tenant_policy p JOIN tenants t ON t.id = p.tenant_id WHERE p.tenant_id = ? AND NOT EXISTS (SELECT 1 FROM tenant_deletions d WHERE d.tenant_id = p.tenant_id)'
		)
		.bind(tenantId)
		.first<Record<string, unknown>>();
	if (!row) return null;
	return {
		tenantId,
		revision: count(row.revision, 'revision'),
		routingRevision: count(row.routing_revision, 'routing revision'),
		analyticsRevision: count(row.analytics_revision, 'analytics revision'),
		analyticsShardId: text(row.analytics_shard_id, 'shard'),
		activeLinkLimit: count(row.active_link_limit, 'link limit'),
		domainLimit: count(row.domain_limit, 'domain limit'),
		monthlyClickLimit: count(row.monthly_click_limit, 'click limit'),
		retentionDays: count(row.retention_days, 'retention'),
		suspendedAt: row.suspended_at === null ? null : count(row.suspended_at, 'suspension time')
	};
}

// Sets or clears the operator's suspension as the next revision. Returns null for no tenant or
// a tenant whose deletion has started, and changed false when the tenant is already in that
// state, so a repeated request takes no revision.
export async function setTenantSuspension(
	db: D1Database,
	tenantId: string,
	suspension: { reason: BlockReason } | null,
	now: number
): Promise<{ revision: number; changed: boolean } | null> {
	const row = await db
		.prepare(
			`UPDATE tenant_policy SET revision = revision + 1, suspended_at = ?1, suspended_reason = ?2, updated_at = ?3
			WHERE tenant_id = ?4 AND (suspended_at IS NULL) = (?1 IS NOT NULL)
			AND NOT EXISTS (SELECT 1 FROM tenant_deletions WHERE tenant_id = ?4) RETURNING revision`
		)
		.bind(suspension ? now : null, suspension?.reason ?? null, now, tenantId)
		.first<{ revision: unknown }>();
	if (row) return { revision: count(row.revision, 'revision'), changed: true };
	const current = await readPolicyProjection(db, tenantId);
	return current ? { revision: current.revision, changed: false } : null;
}

export type PolicyStore = 'routing' | 'analytics';

const revisionColumn: Record<PolicyStore, string> = {
	routing: 'routing_revision',
	analytics: 'analytics_revision'
};

export async function listPendingProjections(
	db: D1Database,
	store: PolicyStore,
	limit: number
): Promise<string[]> {
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
		throw new Error('Invalid projection batch size');
	const column = revisionColumn[store];
	const { results } = await db
		.prepare(
			`SELECT tenant_id FROM tenant_policy p WHERE ${column} < revision AND NOT EXISTS (SELECT 1 FROM tenant_deletions d WHERE d.tenant_id = p.tenant_id) ORDER BY updated_at, tenant_id LIMIT ?`
		)
		.bind(limit)
		.all<{ tenant_id: unknown }>();
	return results.map((row) => text(row.tenant_id, 'tenant'));
}

// The store holds the revision, so record it and activate the tenant in the same batch. A
// tenant activates once routing and analytics both hold a policy; activation never reverts.
export async function acknowledgeProjection(
	db: D1Database,
	store: PolicyStore,
	tenantId: string,
	revision: number,
	now: number
): Promise<void> {
	const column = revisionColumn[store];
	await db.batch([
		db
			.prepare(`UPDATE tenant_policy SET ${column} = ? WHERE tenant_id = ? AND ${column} < ?`)
			.bind(revision, tenantId, revision),
		db
			.prepare(
				'UPDATE tenants SET activated_at = ? WHERE id = ? AND activated_at IS NULL AND EXISTS (SELECT 1 FROM tenant_policy WHERE tenant_id = ? AND routing_revision >= 1 AND analytics_revision >= 1)'
			)
			.bind(now, tenantId, tenantId)
	]);
}

// Ends every sign-in session, API token, and connected app of the tenant's members in one batch.
export async function deleteTenantCredentials(db: D1Database, tenantId: string): Promise<void> {
	const members = 'SELECT user_id FROM tenant_memberships WHERE tenant_id = ?';
	await db.batch(
		[
			'DELETE FROM "session" WHERE "userId" IN',
			'DELETE FROM "apikey" WHERE "referenceId" IN',
			'DELETE FROM "oauthAccessToken" WHERE "userId" IN',
			'DELETE FROM "oauthRefreshToken" WHERE "userId" IN',
			'DELETE FROM "oauthConsent" WHERE "userId" IN'
		].map((statement) => db.prepare(`${statement} (${members})`).bind(tenantId))
	);
}
