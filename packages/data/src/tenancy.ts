// SPDX-License-Identifier: AGPL-3.0-only
// Identity-store records for the installation, tenants, owner memberships, and source policy.
import type { D1Database } from '@cloudflare/workers-types/index.ts';

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
}

export interface PolicyProjection {
	tenantId: string;
	revision: number;
	routingRevision: number;
	analyticsShardId: string;
	activeLinkLimit: number;
	domainLimit: number;
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
			'SELECT m.tenant_id, t.activated_at FROM tenant_memberships m JOIN tenants t ON t.id = m.tenant_id WHERE m.user_id = ? ORDER BY m.created_at, m.tenant_id LIMIT 2'
		)
		.bind(userId)
		.all<{ tenant_id: unknown; activated_at: unknown }>();
	return results.map((row) => ({
		tenantId: text(row.tenant_id, 'tenant'),
		activated: row.activated_at !== null
	}));
}

// One batch: a database guard (missing installation, single mode, one workspace per user)
// rejects the whole tenant, so no partial tenant is left behind.
export async function createTenant(db: D1Database, tenant: NewTenant): Promise<void> {
	checkLimits(tenant.limits);
	const { limits, now } = tenant;
	await db.batch([
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
	]);
}

export async function readPolicyProjection(
	db: D1Database,
	tenantId: string
): Promise<PolicyProjection | null> {
	const row = await db
		.prepare(
			'SELECT p.revision, p.routing_revision, t.analytics_shard_id, p.active_link_limit, p.domain_limit FROM tenant_policy p JOIN tenants t ON t.id = p.tenant_id WHERE p.tenant_id = ?'
		)
		.bind(tenantId)
		.first<Record<string, unknown>>();
	if (!row) return null;
	return {
		tenantId,
		revision: count(row.revision, 'revision'),
		routingRevision: count(row.routing_revision, 'routing revision'),
		analyticsShardId: text(row.analytics_shard_id, 'shard'),
		activeLinkLimit: count(row.active_link_limit, 'link limit'),
		domainLimit: count(row.domain_limit, 'domain limit')
	};
}

export async function listPendingRoutingProjections(
	db: D1Database,
	limit: number
): Promise<string[]> {
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
		throw new Error('Invalid projection batch size');
	const { results } = await db
		.prepare(
			'SELECT tenant_id FROM tenant_policy WHERE routing_revision < revision ORDER BY updated_at, tenant_id LIMIT ?'
		)
		.bind(limit)
		.all<{ tenant_id: unknown }>();
	return results.map((row) => text(row.tenant_id, 'tenant'));
}

// Routing holds the revision, so record it and activate the tenant in the same batch.
export async function acknowledgeRoutingProjection(
	db: D1Database,
	tenantId: string,
	revision: number,
	now: number
): Promise<void> {
	await db.batch([
		db
			.prepare(
				'UPDATE tenant_policy SET routing_revision = ? WHERE tenant_id = ? AND routing_revision < ?'
			)
			.bind(revision, tenantId, revision),
		db
			.prepare(
				'UPDATE tenants SET activated_at = ? WHERE id = ? AND activated_at IS NULL AND EXISTS (SELECT 1 FROM tenant_policy WHERE tenant_id = ? AND routing_revision >= 1)'
			)
			.bind(now, tenantId, tenantId)
	]);
}
