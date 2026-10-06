// SPDX-License-Identifier: AGPL-3.0-only
// Routing-store copy of a tenant's policy. Only a newer revision replaces the stored one.
import type { D1Database } from '@cloudflare/workers-types/index.ts';

export interface RoutingPolicy {
	tenantId: string;
	revision: number;
	analyticsShardId: string;
	activeLinkLimit: number;
	domainLimit: number;
	// Set while the operator suspends the tenant; its links then do not redirect.
	suspendedAt: number | null;
	now: number;
}

export async function applyRoutingPolicy(db: D1Database, policy: RoutingPolicy): Promise<void> {
	await db
		.prepare(
			'INSERT INTO tenant_policy (tenant_id, revision, analytics_shard_id, active_link_limit, domain_limit, suspended_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(tenant_id) DO UPDATE SET revision = excluded.revision, analytics_shard_id = excluded.analytics_shard_id, active_link_limit = excluded.active_link_limit, domain_limit = excluded.domain_limit, suspended_at = excluded.suspended_at, updated_at = excluded.updated_at WHERE excluded.revision > tenant_policy.revision'
		)
		.bind(
			policy.tenantId,
			policy.revision,
			policy.analyticsShardId,
			policy.activeLinkLimit,
			policy.domainLimit,
			policy.suspendedAt,
			policy.now
		)
		.run();
}

export interface LimitUsage {
	tenantId: string;
	revision: number;
	links: { used: number; limit: number };
	domains: { used: number; limit: number };
}

function count(value: unknown, field: string): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
		throw new Error(`Invalid stored ${field}`);
	return value;
}

// Active links and domains in use count against the limits, as creation counts them.
const limitUsageColumns = `p.tenant_id, p.revision, p.active_link_limit, p.domain_limit,
	(SELECT COUNT(*) FROM links WHERE tenant_id = p.tenant_id AND status = 'active') AS links,
	(SELECT COUNT(*) FROM domains WHERE tenant_id = p.tenant_id AND state != 'disabled') AS domains`;

function toLimitUsage(row: Record<string, unknown>): LimitUsage {
	if (typeof row.tenant_id !== 'string' || !row.tenant_id) throw new Error('Invalid stored tenant');
	return {
		tenantId: row.tenant_id,
		revision: count(row.revision, 'revision'),
		links: {
			used: count(row.links, 'link count'),
			limit: count(row.active_link_limit, 'link limit')
		},
		domains: {
			used: count(row.domains, 'domain count'),
			limit: count(row.domain_limit, 'domain limit')
		}
	};
}

export async function readLimitUsage(db: D1Database, tenantId: string): Promise<LimitUsage | null> {
	const row = await db
		.prepare(`SELECT ${limitUsageColumns} FROM tenant_policy p WHERE p.tenant_id = ?`)
		.bind(tenantId)
		.first<Record<string, unknown>>();
	return row ? toLimitUsage(row) : null;
}

// Every tenant in tenant order after the cursor, for the daily notice check.
export async function listLimitUsage(
	db: D1Database,
	after: string,
	limit: number
): Promise<LimitUsage[]> {
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
		throw new Error('Invalid usage batch size');
	const { results } = await db
		.prepare(
			`SELECT ${limitUsageColumns} FROM tenant_policy p WHERE p.tenant_id > ? ORDER BY p.tenant_id LIMIT ?`
		)
		.bind(after, limit)
		.all<Record<string, unknown>>();
	return results.map(toLimitUsage);
}
