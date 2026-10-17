// SPDX-License-Identifier: AGPL-3.0-only
// The scheduled jobs of a standalone Worker. Each job does bounded work per run and records its
// outcome in job_runs; /healthz reports whether the frequent run keeps going.
import { purgeExpired } from '@flared/data/analytics';
import { deleteExpiredDomainChallenges } from '@flared/data/domain-challenges';
import { deleteExpiredCreationRecords } from '@flared/data/links';
import { deleteExpiredMemberEvents } from '@flared/data/members';
import { deleteExpiredOAuthRecords } from '@flared/data/oauth';
import { purgeOperations } from '@flared/data/operations';
import { deleteExpiredApiTokens } from '@flared/data/tokens';
import { cleanupOwnerAuthRecords } from '@flared/server/auth/attempts';
import { cleanupAutomations, runAutomationJob } from '@flared/server/automations';
import { cleanupDeletions, runDeletions, type DeletionDependencies } from '@flared/server/deletion';
import { createJobLedger } from '@flared/server/jobs';
import {
	cleanupNotices,
	reconcileClickNotices,
	reconcileLimitNotices
} from '@flared/server/notices';
import { measureShards } from '@flared/server/operations';
import { retryProjections } from '@flared/server/tenancy';
import { cleanupWebhooks, runWebhookJob } from '@flared/server/webhooks';
import { checkWaitingDomains, createWorkerDomainProvider } from '@flared/server/worker-domains';
import type { DeploymentConfig } from './config';
import { checkForUpdates, defaultFeed, type FeedOptions } from './updates';

// See triggers.crons in the root wrangler.jsonc.
export const frequentCron = '*/10 * * * *';

const frequentJobs = [
	'policy_projections',
	'account_deletions',
	'click_notices',
	'shard_samples',
	'domain_checks',
	'automations',
	'webhook_deliveries'
] as const;
const dailyJobs = [
	'auth_cleanup',
	'routing_maintenance',
	'analytics_purge',
	'limit_notices',
	'deletion_cleanup',
	'operations_purge',
	'update_check',
	'webhook_cleanup',
	'automation_cleanup'
] as const;
type JobName = (typeof frequentJobs)[number] | (typeof dailyJobs)[number];

export const jobs = createJobLedger<JobName>({
	table: 'job_runs',
	frequent: frequentJobs,
	daily: dailyJobs
});

// The frequent run must have finished this recently for /healthz to answer 200.
const healthyWithinMs = 30 * 60 * 1000;

// The app host is null only before setup, when no workspace can be deleted.
export type JobConfig = DeploymentConfig & { host: string | null };

// The installation's own hostname, as the API reserves it.
function reservedHostnames(config: JobConfig): string[] {
	return config.host ? [config.host] : [];
}

export function deletionDependencies(config: JobConfig): DeletionDependencies {
	// No email in this edition, and no records of its own beyond the core tables.
	return {
		identity: config.identity,
		routing: config.routing,
		shards: config.shards,
		domains: {
			provider: createWorkerDomainProvider({ routing: config.routing }),
			reservedHostnames: reservedHostnames(config)
		}
	};
}

async function retryPolicyProjections(config: JobConfig, now: number): Promise<void> {
	const stores = { routing: config.routing, analytics: config.shards };
	const result = await retryProjections(config.identity, stores, now, 100);
	if (result.failed > 0) throw new Error('Policy projections failed');
}

async function runAccountDeletions(config: JobConfig): Promise<void> {
	const result = await runDeletions(deletionDependencies(config));
	if (result.failed > 0) throw new Error('A deletion step failed');
}

async function recordClickNotices(config: JobConfig, now: number): Promise<void> {
	const result = await reconcileClickNotices(config.identity, config.shards, now);
	if (result.failed > 0) throw new Error('Click notices failed');
}

// One size sample of the analytics database an hour, from the first frequent run of the hour.
async function sampleShards(config: JobConfig, scheduledTime: number): Promise<void> {
	if (new Date(scheduledTime).getUTCMinutes() >= 10) return;
	const measured = await measureShards(config.identity, config.shards, scheduledTime);
	if (measured.some((shard) => shard.sample === null)) throw new Error('Shard sampling failed');
}

// The 10-minute runs take turns, so that one run stays inside the 50 subrequests and 50 D1
// queries that Workers Free allows for each invocation: with k = the scheduled UTC minute / 10,
// domain checks run when k is even (:00, :20, :40) and automations when k is odd (:10, :30, :50).
// A job outside its turn returns at once and still records a successful run. Measured worst
// cases (tests/worker.test.ts), with a pending policy projection and 30 due deliveries:
// - even turn, on the hour, 5 waiting domains, milestones waiting: 45 queries, 28 fetches;
// - odd turn, 25 due automations with every action, milestones waiting: 42 queries, 25 fetches;
// - the odd turn at :30 with that work and 10 due destination checks, each 3 requests to new
//   hosts: 47 queries, 43 fetches (6 checks run).
function automationTurn(scheduledTime: number): boolean {
	return Math.floor(new Date(scheduledTime).getUTCMinutes() / 10) % 2 === 1;
}

// Each check is one fetch and 3 queries; 3 checks are 11 queries with the ledger and 3 fetches.
// 5 checks would take the even turn's worst case to 51 queries.
async function checkDomains(config: JobConfig, scheduledTime: number, now: number): Promise<void> {
	if (automationTurn(scheduledTime)) return;
	const result = await checkWaitingDomains({
		routing: config.routing,
		provider: createWorkerDomainProvider({ routing: config.routing, now: () => now }),
		limit: 3,
		now: () => now
	});
	if (result.failed > 0) throw new Error('Domain checks failed');
}

// Destination checks go out with the requests that name this page.
const checkUserAgent =
	'Flared-LinkCheck/1.0 (+https://github.com/FlaredLink/Flared/blob/main/docs/self-hosting/automations.md)';

// Applications whose destination one run checks. Each check takes up to 3 requests, and the
// webhook job in the same run sends up to 25, so 6 checks keep the run at 43 requests or fewer.
const checksPerRun = 6;

// Destination checks run only in the turn at :30 (k = 3); the shard sample has the turn at :00.
function checkTurn(scheduledTime: number): boolean {
	return Math.floor(new Date(scheduledTime).getUTCMinutes() / 10) === 3;
}

// In the :30 turn, destination checks first: up to 5 queries and 18 requests. Then click
// milestones and 25 due applications at most: 14 queries with the ledger and no request. The
// events that the runs stage go out with the webhook job in the same invocation.
function runAutomations(config: JobConfig, now: number, scheduledTime: number): Promise<void> {
	return runAutomationJob(
		{ identity: config.identity, routing: config.routing, analytics: config.shards },
		{
			email: false,
			maxApplications: 25,
			now: () => now,
			checks: checkTurn(scheduledTime)
				? {
						limit: checksPerRun,
						concurrency: 5,
						userAgent: checkUserAgent,
						reservedHostnames: reservedHostnames(config)
					}
				: undefined
		}
	).then(() => undefined);
}

// Events that a request or an automation left, and retries; in a domain-check turn, click
// milestones too. 25 deliveries, 5 at once: 25 fetches, and 12 queries with the ledger, or 8 in
// an automation turn. There the job waits for the automation run, so the events that it staged go
// out in the same run, and the automation job has moved the milestones. A receiver's failure is
// recorded with its delivery; it does not fail the job.
async function deliverWebhooks(
	config: JobConfig,
	now: number,
	automations: Promise<void> | null
): Promise<void> {
	if (automations) await automations.catch(() => {});
	await runWebhookJob(
		{ routing: config.routing, analytics: config.shards },
		{
			secret: config.secret,
			reservedHostnames: reservedHostnames(config),
			now: () => now,
			maxDeliveries: 25,
			concurrency: 5,
			transferMilestones: automations === null
		}
	);
}

async function cleanupAuth(config: JobConfig, now: number): Promise<void> {
	await cleanupOwnerAuthRecords(config.identity, now, 1000);
	await deleteExpiredOAuthRecords(config.identity, now, 1000);
	await deleteExpiredApiTokens(config.identity, now, 1000);
}

async function maintainRouting(config: JobConfig, now: number): Promise<void> {
	await deleteExpiredCreationRecords(config.routing, now, 1000);
	await deleteExpiredDomainChallenges(config.routing, now, 1000);
}

// Removes aggregates past the retention and receipts past the replay window, in bounded rounds.
async function purgeAnalytics(config: JobConfig, now: number): Promise<void> {
	for (const db of Object.values(config.shards))
		for (let round = 0; round < 20; round += 1)
			if ((await purgeExpired(db, now, 1000)).deleted === 0) break;
}

async function limitNotices(config: JobConfig, now: number): Promise<void> {
	await reconcileLimitNotices(config.identity, config.routing, now);
	await cleanupNotices(config.identity, now);
}

async function purgeOperationRecords(config: JobConfig, now: number): Promise<void> {
	for (let round = 0; round < 20; round += 1)
		if ((await purgeOperations(config.identity, now, 1000)).deleted === 0) break;
	for (let round = 0; round < 20; round += 1)
		if ((await deleteExpiredMemberEvents(config.identity, now, 1000)).deleted === 0) break;
}

export async function runScheduled(
	cron: string,
	scheduledTime: number,
	config: JobConfig,
	feed: FeedOptions = defaultFeed
): Promise<void> {
	const now = Date.now();
	const run = (list: [JobName, () => Promise<void>][]) =>
		Promise.allSettled(list.map(([job, task]) => jobs.trackJob(config.identity, job, task)));
	// Started once, so the webhook job can wait for it; null outside the automation turn.
	const automations =
		cron === frequentCron && automationTurn(scheduledTime)
			? runAutomations(config, now, scheduledTime)
			: null;
	const results =
		cron === frequentCron
			? await run([
					['policy_projections', () => retryPolicyProjections(config, now)],
					['account_deletions', () => runAccountDeletions(config)],
					['click_notices', () => recordClickNotices(config, now)],
					['shard_samples', () => sampleShards(config, scheduledTime)],
					['domain_checks', () => checkDomains(config, scheduledTime, now)],
					['automations', async () => void (await automations)],
					['webhook_deliveries', () => deliverWebhooks(config, now, automations)]
				])
			: await run([
					['auth_cleanup', () => cleanupAuth(config, now)],
					['routing_maintenance', () => maintainRouting(config, now)],
					['analytics_purge', () => purgeAnalytics(config, now)],
					['limit_notices', () => limitNotices(config, now)],
					['deletion_cleanup', async () => void (await cleanupDeletions(config.identity, now))],
					['operations_purge', () => purgeOperationRecords(config, now)],
					// Off unless the owner turned it on; a failed fetch is recorded, not thrown.
					['update_check', async () => void (await checkForUpdates(config.identity, feed, now))],
					['webhook_cleanup', async () => void (await cleanupWebhooks(config.routing, now))],
					['automation_cleanup', async () => void (await cleanupAutomations(config.routing, now))]
				]);
	for (const result of results) if (result.status === 'rejected') throw result.reason;
}

// For an outside uptime monitor: did the frequent run finish in the last 30 minutes?
export async function handleHealthz(request: Request, config: JobConfig): Promise<Response> {
	if (request.method !== 'GET' && request.method !== 'HEAD')
		return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } });
	const now = Date.now();
	let healthy = false;
	try {
		const statuses = await jobs.readJobStatuses(config.identity, now);
		const frequent = statuses.find((status) => status.job === 'policy_projections');
		healthy =
			frequent?.lastFinishedAt !== null &&
			frequent?.lastFinishedAt !== undefined &&
			now - frequent.lastFinishedAt <= healthyWithinMs;
	} catch {
		healthy = false;
	}
	return new Response(request.method === 'HEAD' ? null : healthy ? 'ok\n' : 'stale\n', {
		status: healthy ? 200 : 503,
		headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' }
	});
}
