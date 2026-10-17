// SPDX-License-Identifier: AGPL-3.0-only
// Applying a template to links. A clicks template also needs each link's counted clicks, which
// live on the workspace's analytics shard.
import type { D1Database } from '@cloudflare/workers-types/index.ts';
import type { AutomationTriggerType } from '@flared/contracts/automations';
import { readLinkClickTotals } from '@flared/data/analytics';
import {
	applyAutomation,
	recordClickTotals,
	type ApplyRequest,
	type ApplyResult
} from '@flared/data/automations';
import { readTenantShard } from '@flared/data/tenancy';
import { resolveShard, type AnalyticsShards } from '../shards';

export interface ApplyStores {
	identity: D1Database;
	routing: D1Database;
	// Without shards, a clicks template becomes due at the next milestone of each link.
	analytics?: AnalyticsShards;
}

// Applies the template to each link in one statement. For a clicks template, the counted clicks
// of the links applied now are read after that insert, so a milestone moved in between marks the
// application itself and one moved before it is in the total. A failed read is logged and does
// not fail the apply: the application becomes due at the link's next milestone, at most 100
// clicks later. 1 statement, 2 when a link was not applied, and up to 3 more for clicks.
export async function applyToLinks(
	stores: ApplyStores,
	request: ApplyRequest,
	trigger: AutomationTriggerType
): Promise<ApplyResult> {
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
