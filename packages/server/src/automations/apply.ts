// SPDX-License-Identifier: AGPL-3.0-only
// Applying a template to links. A clicks template also needs each link's counted clicks, which
// live on the workspace's analytics shard.
import type { D1Database } from '@cloudflare/workers-types/index.ts';
import type { AutomationTriggerType } from '@flared/contracts/automations';
import { readLinkClickTotals } from '@flared/data/analytics';
import {
	applyAutomation,
	readLinkDestinations,
	recordClickTotals,
	type ApplyLinkOutcome,
	type ApplyRequest
} from '@flared/data/automations';
import { readTenantShard } from '@flared/data/tenancy';
import { resolveShard, type AnalyticsShards } from '../shards';
import { checkableUrl } from './checks';

export interface ApplyStores {
	identity: D1Database;
	routing: D1Database;
	// Without shards, a clicks template becomes due at the next milestone of each link.
	analytics?: AnalyticsShards;
}

// not_checkable: a destination_down template, and a destination that a check may not request.
export type LinkApplyOutcome = ApplyLinkOutcome | 'not_checkable';

export type LinkApplyResult =
	| { status: 'not_found' }
	| { status: 'off' }
	| { status: 'done'; links: { linkId: string; outcome: LinkApplyOutcome }[] };

// Applies the template to each link in one statement. For a clicks template, the counted clicks
// of the links applied now are read after that insert, so a milestone moved in between marks the
// application itself and one moved before it is in the total. A failed read is logged and does
// not fail the apply: the application becomes due at the link's next milestone, at most 100
// clicks later. A destination_down template first reads the destinations and leaves out each
// link whose destination fails checkableUrl, which then fails as not_checkable. 1 statement, 2
// when a link was not applied, 1 more for destination_down, and up to 3 more for clicks.
export async function applyToLinks(
	stores: ApplyStores,
	request: ApplyRequest,
	trigger: AutomationTriggerType,
	reservedHostnames: readonly string[]
): Promise<LinkApplyResult> {
	if (trigger === 'destination_down') {
		const linkIds = [...new Set(request.linkIds)];
		const destinations = await readLinkDestinations(stores.routing, request.tenantId, linkIds);
		const refused = new Set(
			[...destinations]
				.filter(([, destination]) => checkableUrl(destination, reservedHostnames) === null)
				.map(([linkId]) => linkId)
		);
		if (refused.size === 0) return applyAutomation(stores.routing, request);
		const rest = linkIds.filter((linkId) => !refused.has(linkId));
		const result =
			rest.length > 0
				? await applyAutomation(stores.routing, { ...request, linkIds: rest })
				: { status: 'done' as const, links: [] };
		if (result.status !== 'done') return result;
		const outcomes = new Map(result.links.map((link) => [link.linkId, link.outcome]));
		return {
			status: 'done',
			links: linkIds.map((linkId) => ({
				linkId,
				outcome: refused.has(linkId) ? 'not_checkable' : (outcomes.get(linkId) ?? 'not_found')
			}))
		};
	}
	const result = await applyAutomation(stores.routing, request);
	if (result.status !== 'done' || trigger !== 'clicks' || !stores.analytics) return result;
	const applied = result.links.filter((link) => link.outcome === 'applied');
	if (applied.length === 0) return result;
	try {
		const shardId = await readTenantShard(stores.identity, request.tenantId);
		if (!shardId) throw new Error('Workspace has no analytics shard');
		const totals = await readLinkClickTotals(
			resolveShard(stores.analytics, shardId),
			request.tenantId,
			applied.map((link) => link.linkId)
		);
		const counted = [...totals]
			.filter(([, clicks]) => clicks > 0)
			.map(([linkId, clicks]) => ({ linkId, clicks }));
		await recordClickTotals(stores.routing, {
			tenantId: request.tenantId,
			automationId: request.automationId,
			totals: counted,
			now: request.now
		});
	} catch {
		console.error(
			JSON.stringify({
				event: 'automation_click_totals_failed',
				automationId: request.automationId
			})
		);
	}
	return result;
}
