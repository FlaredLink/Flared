// SPDX-License-Identifier: AGPL-3.0-only
// The scheduled automation work: move click milestones, finish due applications that will not
// run, run the due ones, and record the owner's email notices. Events that a run stages go out
// with the webhook job, so an edition runs that job after this one in the same invocation.
import type { D1Database } from '@cloudflare/workers-types/index.ts';
import { newAutomationRunId } from '@flared/contracts/automations';
import { newWebhookEventId } from '@flared/contracts/webhooks';
import {
	claimAutomations,
	deleteOldAutomationRuns,
	recordSkippedRuns,
	runAutomations,
	type AutomationEmail
} from '@flared/data/automations';
import { recordNotices, type NewNotice } from '@flared/data/notices';
import type { AnalyticsShards } from '../shards';
import {
	checkDestinations,
	type DestinationCheckSettings,
	type DestinationCheckSummary
} from './checks';
import { transferClickMilestones } from './milestones';
import { automationNoticeKind } from './notices';

export type { DestinationCheckSettings, DestinationCheckSummary } from './checks';

// claimAutomations takes at most this many at once.
const claimBatch = 100;
// recordNotices takes at most 100 notices per statement.
const noticeBatch = 100;
// Run records deleted in each statement of a cleanup run, and statements in one run.
const cleanupBatch = 1000;
const cleanupRounds = 20;

export interface AutomationJobOptions {
	// Records one email notice per template and run for templates that email the owner. An
	// installation without email passes false; its templates cannot have that action.
	email: boolean;
	// Applications run in one job, in rounds of at most 100. 25 by default.
	maxApplications?: number;
	// Destination checks for destination_down templates, run first, so a destination found down
	// a second time runs in the same job. Without it, nothing is checked.
	checks?: DestinationCheckSettings;
	now?: () => number;
}

export interface AutomationJobSummary {
	// Webhook events written for moved click milestones.
	milestones: number;
	// Due applications finished without running: skipped for the plan or a template that is off,
	// or failed after too many attempts.
	skipped: number;
	claimed: number;
	ran: number;
	notices: number;
	// Null when the job ran without checks.
	checks: DestinationCheckSummary | null;
}

function notice(email: AutomationEmail, token: string, now: number): NewNotice {
	return {
		tenantId: email.tenantId,
		kind: automationNoticeKind,
		dedupeKey: `${automationNoticeKind}:${email.automationId}:${token}`,
		params: {
			automationId: email.automationId,
			automationName: email.automationName,
			links: email.links,
			failed: email.failed,
			...(email.shortUrl === null ? {} : { shortUrl: email.shortUrl })
		},
		now
	};
}

// Statements: with checks, the check claim (and 2 to 4 more when it claims any; see
// checkDestinations); the milestone transfer (1 read per shard; 4 with milestones), then in each
// round the 2-statement claim, 1 for skipped run records, and the 8-statement run batch, then 1
// for notices; each only when it has work. Idle: 1 per shard and 2, and 1 with checks. The emails
// are recorded after the run batches, so a stop in between loses it: at most once. Failed checks
// or a shard that fails do not stop the runs; the job then throws, so the edition records a
// failure.
export async function runAutomationJob(
	stores: { identity: D1Database; routing: D1Database; analytics: AnalyticsShards },
	options: AutomationJobOptions
): Promise<AutomationJobSummary> {
	const { identity, routing } = stores;
	const now = (options.now ?? Date.now)();
	const maxApplications = options.maxApplications ?? 25;
	if (!Number.isSafeInteger(maxApplications) || maxApplications < 1)
		throw new Error('Invalid automation run limit');
	let checks: DestinationCheckSummary | null = null;
	let checkError: unknown = null;
	if (options.checks)
		try {
			checks = await checkDestinations({ routing }, { ...options.checks, now });
		} catch (error) {
			checkError = error;
			console.error(JSON.stringify({ event: 'destination_checks_failed' }));
		}
	const { milestones, failedShards } = await transferClickMilestones(stores, now);
	const summary: AutomationJobSummary = {
		milestones,
		skipped: 0,
		claimed: 0,
		ran: 0,
		notices: 0,
		checks
	};
	// One email per template per job run, whatever the number of rounds.
	const emails = new Map<string, AutomationEmail>();
	const invocation = crypto.randomUUID();
	while (summary.claimed < maxApplications) {
		const limit = Math.min(claimBatch, maxApplications - summary.claimed);
		const token = crypto.randomUUID();
		const { claimed, skipped } = await claimAutomations(routing, { token, now, limit });
		await recordSkippedRuns(routing, { token, now, skipped });
		summary.skipped += skipped.length;
		summary.claimed += claimed.length;
		if (claimed.length > 0) {
			const result = await runAutomations(routing, {
				token,
				now,
				items: claimed.map(({ linkId, automationId }) => ({
					linkId,
					automationId,
					linkEventId: newWebhookEventId(),
					triggerEventId: newWebhookEventId(),
					runId: newAutomationRunId()
				}))
			});
			summary.ran += result.ran;
			for (const email of result.emails) {
				const key = `${email.tenantId}:${email.automationId}`;
				const seen = emails.get(key);
				emails.set(
					key,
					seen
						? {
								...seen,
								links: seen.links + email.links,
								failed: seen.failed + email.failed,
								shortUrl: null
							}
						: email
				);
			}
		}
		if (claimed.length < limit) break;
	}
	if (options.email) {
		const pending = [...emails.values()].map((email) => notice(email, invocation, now));
		for (let start = 0; start < pending.length; start += noticeBatch)
			summary.notices += await recordNotices(identity, pending.slice(start, start + noticeBatch));
	}
	if (failedShards.length > 0)
		throw new Error('Click milestones could not be moved from every analytics shard');
	if (checkError !== null) throw checkError;
	return summary;
}

// The daily run: run records past 90 days are deleted, in rounds of 1000, at most 20 rounds.
export async function cleanupAutomations(
	routing: D1Database,
	now: number
): Promise<{ deleted: number }> {
	let deleted = 0;
	for (let round = 0; round < cleanupRounds; round += 1) {
		const count = await deleteOldAutomationRuns(routing, now, cleanupBatch);
		deleted += count;
		if (count < cleanupBatch) break;
	}
	return { deleted };
}
