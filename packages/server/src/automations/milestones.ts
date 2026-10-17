// SPDX-License-Identifier: AGPL-3.0-only
// The move of click milestones from the analytics shards to routing, where they become webhook
// events and mark the clicks automations they reach. The automation job runs it; the webhook job
// can run it too, and a repeat writes nothing twice.
import type { D1Database } from '@cloudflare/workers-types/index.ts';
import { markClickApplications } from '@flared/data/automations';
import {
	deleteClickMilestones,
	milestoneEventsStatement,
	readClickMilestones
} from '@flared/data/webhooks';
import type { AnalyticsShards } from '../shards';

// Milestones moved from each shard in one run.
const milestoneBatch = 50;

// For each shard: a read, then one routing batch that writes the webhook events and marks the
// waiting clicks applications, then the shard deletes the milestones (only the read when none
// wait). Both writes come before the delete and are safe to repeat, so a stop in between writes
// nothing twice. A shard that fails is logged and named in failedShards; the others still move.
// milestones is the number of webhook events written.
export async function transferClickMilestones(
	stores: { routing: D1Database; analytics: AnalyticsShards },
	now: number
): Promise<{ milestones: number; failedShards: string[] }> {
	const { routing } = stores;
	let milestones = 0;
	const failedShards: string[] = [];
	for (const [shardId, shard] of Object.entries(stores.analytics))
		try {
			const waiting = await readClickMilestones(shard, milestoneBatch);
			if (waiting.length === 0) continue;
			const [events] = await routing.batch([
				milestoneEventsStatement(routing, waiting),
				markClickApplications(routing, waiting, now)
			]);
			milestones += events.meta.changes;
			await deleteClickMilestones(
				shard,
				waiting.map((milestone) => milestone.id)
			);
		} catch {
			failedShards.push(shardId);
			console.error(JSON.stringify({ event: 'click_milestones_failed', shardId }));
		}
	return { milestones, failedShards };
}
