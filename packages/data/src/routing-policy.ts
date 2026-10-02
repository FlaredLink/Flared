// SPDX-License-Identifier: AGPL-3.0-only
// Routing-store copy of a tenant's policy. Only a newer revision replaces the stored one.
import type { D1Database } from '@cloudflare/workers-types/index.ts';

export interface RoutingPolicy {
	tenantId: string;
	revision: number;
	analyticsShardId: string;
	activeLinkLimit: number;
	domainLimit: number;
	now: number;
}

export async function applyRoutingPolicy(db: D1Database, policy: RoutingPolicy): Promise<void> {
	await db
		.prepare(
			'INSERT INTO tenant_policy (tenant_id, revision, analytics_shard_id, active_link_limit, domain_limit, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(tenant_id) DO UPDATE SET revision = excluded.revision, analytics_shard_id = excluded.analytics_shard_id, active_link_limit = excluded.active_link_limit, domain_limit = excluded.domain_limit, updated_at = excluded.updated_at WHERE excluded.revision > tenant_policy.revision'
		)
		.bind(
			policy.tenantId,
			policy.revision,
			policy.analyticsShardId,
			policy.activeLinkLimit,
			policy.domainLimit,
			policy.now
		)
		.run();
}
