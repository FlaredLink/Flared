// SPDX-License-Identifier: AGPL-3.0-only
import type { D1Database } from '@cloudflare/workers-types/index.ts';
import { applyRoutingPolicy } from '@flared/data/routing-policy';
import {
	acknowledgeRoutingProjection,
	listMemberships,
	listPendingRoutingProjections,
	readPolicyProjection
} from '@flared/data/tenancy';

export type TenantResolution =
	| { status: 'active'; tenantId: string }
	| { status: 'pending'; tenantId: string }
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
		status: membership.activated ? 'active' : 'pending',
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
	await acknowledgeRoutingProjection(identity, tenantId, policy.revision, now);
}

export async function retryRoutingProjections(
	identity: D1Database,
	routing: D1Database,
	now: number,
	limit: number
): Promise<{ projected: number; failed: number }> {
	let projected = 0;
	let failed = 0;
	for (const tenantId of await listPendingRoutingProjections(identity, limit)) {
		try {
			await projectRoutingPolicy(identity, routing, tenantId, now);
			projected += 1;
		} catch {
			failed += 1;
			console.error(JSON.stringify({ event: 'policy_projection_failed', tenantId }));
		}
	}
	return { projected, failed };
}
