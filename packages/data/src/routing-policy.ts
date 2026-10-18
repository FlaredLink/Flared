// SPDX-License-Identifier: AGPL-3.0-only
// Routing-store copy of a tenant's policy. Only a newer revision replaces the stored one.
import type { D1Database } from '@cloudflare/workers-types/index.ts';

export interface RoutingPolicy {
	tenantId: string;
	revision: number;
	analyticsShardId: string;
	activeLinkLimit: number;
	domainLimit: number;
	webhookEndpointLimit: number;
	automationLimit: number;
	// Set while the operator suspends the tenant; its links then do not redirect.
	suspendedAt: number | null;
	now: number;
}

// A row at the same revision is replaced only while its webhook endpoint limit or automation limit
// is NULL: it was projected before routing stored that limit, and no migration takes a new
// revision for it.
export async function applyRoutingPolicy(db: D1Database, policy: RoutingPolicy): Promise<void> {
	await db
		.prepare(
			`INSERT INTO tenant_policy (tenant_id, revision, analytics_shard_id, active_link_limit, domain_limit, webhook_endpoint_limit, automation_limit, suspended_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(tenant_id) DO UPDATE SET revision = excluded.revision, analytics_shard_id = excluded.analytics_shard_id, active_link_limit = excluded.active_link_limit, domain_limit = excluded.domain_limit, webhook_endpoint_limit = excluded.webhook_endpoint_limit, automation_limit = excluded.automation_limit, suspended_at = excluded.suspended_at, updated_at = excluded.updated_at
			WHERE excluded.revision > tenant_policy.revision OR (excluded.revision = tenant_policy.revision AND (tenant_policy.webhook_endpoint_limit IS NULL OR tenant_policy.automation_limit IS NULL))`
		)
		.bind(
			policy.tenantId,
			policy.revision,
			policy.analyticsShardId,
			policy.activeLinkLimit,
			policy.domainLimit,
			policy.webhookEndpointLimit,
			policy.automationLimit,
			policy.suspendedAt,
			policy.now
		)
		.run();
}

// Tenants whose routing row lacks a limit that a later version added (the webhook endpoint limit
// or the automation limit), for the scheduled heal.
export async function listUnprojectedLimits(db: D1Database, limit: number): Promise<string[]> {
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
		throw new Error('Invalid projection batch size');
	const { results } = await db
		.prepare(
			'SELECT tenant_id FROM tenant_policy WHERE webhook_endpoint_limit IS NULL OR automation_limit IS NULL ORDER BY tenant_id LIMIT ?'
		)
		.bind(limit)
		.all<{ tenant_id: unknown }>();
	return results.map((row) => {
		if (typeof row.tenant_id !== 'string' || !row.tenant_id)
			throw new Error('Invalid stored tenant');
		return row.tenant_id;
	});
}

// Sets the click forwarding flag (routing migration 0011), which the policy projection never
// writes. Returns whether the stored value changed; a tenant without a routing row changes nothing.
export async function setClickForwarding(
	db: D1Database,
	tenantId: string,
	on: boolean,
	now: number
): Promise<boolean> {
	const value = on ? 1 : 0;
	const result = await db
		.prepare(
			'UPDATE tenant_policy SET click_forwarding = ?, updated_at = ? WHERE tenant_id = ? AND click_forwarding <> ?'
		)
		.bind(value, now, tenantId, value)
		.run();
	return result.meta.changes === 1;
}

// Sets the flag for up to 100 workspaces in one statement, for an edition that settles several
// at once. Returns how many rows changed.
export async function setClickForwardingFlags(
	db: D1Database,
	flags: readonly { tenantId: string; on: boolean }[],
	now: number
): Promise<number> {
	if (flags.length === 0) return 0;
	if (flags.length > 100) throw new Error('Too many workspaces for one forwarding update');
	const result = await db
		.prepare(
			`UPDATE tenant_policy SET click_forwarding = r.value, updated_at = ?1
			FROM (SELECT json_extract(value, '$.tenantId') AS tenant_id, json_extract(value, '$.on') AS value
				FROM json_each(?2)) AS r
			WHERE tenant_policy.tenant_id = r.tenant_id AND tenant_policy.click_forwarding <> r.value`
		)
		.bind(now, JSON.stringify(flags.map(({ tenantId, on }) => ({ tenantId, on: on ? 1 : 0 }))))
		.run();
	return result.meta.changes;
}

// Tenants with the flag set, in tenant order after the cursor, for the edition's reconciliation.
export async function listClickForwardingTenants(
	db: D1Database,
	after: string,
	limit: number
): Promise<string[]> {
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
		throw new Error('Invalid forwarding batch size');
	const { results } = await db
		.prepare(
			'SELECT tenant_id FROM tenant_policy WHERE click_forwarding = 1 AND tenant_id > ? ORDER BY tenant_id LIMIT ?'
		)
		.bind(after, limit)
		.all<{ tenant_id: unknown }>();
	return results.map((row) => {
		if (typeof row.tenant_id !== 'string' || !row.tenant_id)
			throw new Error('Invalid stored tenant');
		return row.tenant_id;
	});
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
