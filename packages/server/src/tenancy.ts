// SPDX-License-Identifier: AGPL-3.0-only
import type { D1Database } from '@cloudflare/workers-types/index.ts';
import { applyAnalyticsPolicy } from '@flared/data/analytics';
import { applyRoutingPolicy } from '@flared/data/routing-policy';
import {
	acknowledgeProjection,
	listMemberships,
	listPendingProjections,
	readPolicyProjection,
	updateTenantPolicy,
	type PolicyLimits,
	type PolicyStore
} from '@flared/data/tenancy';
import { resolveShard, type AnalyticsShards } from './shards';

export type TenantResolution =
	| { status: 'active'; tenantId: string }
	| { status: 'pending'; tenantId: string }
	// The workspace is being deleted: nothing may act in it.
	| { status: 'deleting'; tenantId: string }
	| { status: 'none' };

export class TenancyError extends Error {
	constructor(readonly code: 'MULTIPLE_MEMBERSHIPS' | 'POLICY_MISSING') {
		super('Tenant state is inconsistent');
	}
}

// The tenant always comes from the user's stored membership, never from the request.
export async function resolveTenant(
	identity: D1Database,
	userId: string
): Promise<TenantResolution> {
	const memberships = await listMemberships(identity, userId);
	if (memberships.length === 0) return { status: 'none' };
	if (memberships.length > 1) {
		console.error(JSON.stringify({ event: 'tenant_multiple_memberships' }));
		throw new TenancyError('MULTIPLE_MEMBERSHIPS');
	}
	const [membership] = memberships;
	return {
		status: membership.deleting ? 'deleting' : membership.activated ? 'active' : 'pending',
		tenantId: membership.tenantId
	};
}

// Safe to repeat: routing keeps the newest revision, and the acknowledgement only moves forward.
export async function projectRoutingPolicy(
	identity: D1Database,
	routing: D1Database,
	tenantId: string,
	now: number
): Promise<void> {
	const policy = await readPolicyProjection(identity, tenantId);
	if (!policy) throw new TenancyError('POLICY_MISSING');
	if (policy.routingRevision < policy.revision)
		await applyRoutingPolicy(routing, {
			tenantId,
			revision: policy.revision,
			analyticsShardId: policy.analyticsShardId,
			activeLinkLimit: policy.activeLinkLimit,
			domainLimit: policy.domainLimit,
			now
		});
	await acknowledgeProjection(identity, 'routing', tenantId, policy.revision, now);
}

// The policy goes only to the tenant's assigned shard.
export async function projectAnalyticsPolicy(
	identity: D1Database,
	shards: AnalyticsShards,
	tenantId: string,
	now: number
): Promise<void> {
	const policy = await readPolicyProjection(identity, tenantId);
	if (!policy) throw new TenancyError('POLICY_MISSING');
	if (policy.analyticsRevision < policy.revision)
		await applyAnalyticsPolicy(resolveShard(shards, policy.analyticsShardId), {
			tenantId,
			revision: policy.revision,
			monthlyClickLimit: policy.monthlyClickLimit,
			retentionDays: policy.retentionDays,
			now
		});
	await acknowledgeProjection(identity, 'analytics', tenantId, policy.revision, now);
}

export interface PolicyStores {
	routing: D1Database;
	analytics: AnalyticsShards;
}

// Projects a tenant's policy into every store that has not acknowledged its revision yet.
export async function projectPolicy(
	identity: D1Database,
	stores: PolicyStores,
	tenantId: string,
	now: number
): Promise<void> {
	await projectRoutingPolicy(identity, stores.routing, tenantId, now);
	await projectAnalyticsPolicy(identity, stores.analytics, tenantId, now);
}

// Stores new limits as the next revision, then projects them. The identity store is the source
// of truth: a failed projection returns false and retryProjections completes it later.
export async function updatePolicy(
	identity: D1Database,
	stores: PolicyStores,
	tenantId: string,
	limits: PolicyLimits,
	now: number
): Promise<{ revision: number; projected: boolean }> {
	const revision = await updateTenantPolicy(identity, tenantId, limits, now);
	if (revision === null) throw new TenancyError('POLICY_MISSING');
	try {
		await projectPolicy(identity, stores, tenantId, now);
		return { revision, projected: true };
	} catch {
		console.error(JSON.stringify({ event: 'policy_projection_deferred', tenantId }));
		return { revision, projected: false };
	}
}

export async function retryProjections(
	identity: D1Database,
	stores: PolicyStores,
	now: number,
	limit: number
): Promise<{ projected: number; failed: number }> {
	let projected = 0;
	let failed = 0;
	const project: Record<PolicyStore, (tenantId: string) => Promise<void>> = {
		routing: (tenantId) => projectRoutingPolicy(identity, stores.routing, tenantId, now),
		analytics: (tenantId) => projectAnalyticsPolicy(identity, stores.analytics, tenantId, now)
	};
	for (const store of ['routing', 'analytics'] as const)
		for (const tenantId of await listPendingProjections(identity, store, limit)) {
			try {
				await project[store](tenantId);
				projected += 1;
			} catch {
				failed += 1;
				console.error(JSON.stringify({ event: 'policy_projection_failed', store, tenantId }));
			}
		}
	return { projected, failed };
}
