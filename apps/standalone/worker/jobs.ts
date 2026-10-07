// SPDX-License-Identifier: AGPL-3.0-only
// The scheduled jobs of a standalone Worker. Each job does bounded work per run and records its
// outcome in job_runs; /healthz reports whether the frequent run keeps going.
import { purgeExpired } from '@flared/data/analytics';
import { deleteExpiredCreationRecords } from '@flared/data/links';
import { deleteExpiredOAuthRecords } from '@flared/data/oauth';
import { purgeOperations } from '@flared/data/operations';
import { deleteExpiredApiTokens } from '@flared/data/tokens';
import { cleanupOwnerAuthRecords } from '@flared/server/auth/attempts';
import { cleanupDeletions, runDeletions, type DeletionDependencies } from '@flared/server/deletion';
import { createJobLedger } from '@flared/server/jobs';
import {
	cleanupNotices,
	reconcileClickNotices,
	reconcileLimitNotices
} from '@flared/server/notices';
import { measureShards } from '@flared/server/operations';
import { retryProjections } from '@flared/server/tenancy';
import type { StandaloneConfig } from './config';

// See triggers.crons in the root wrangler.jsonc.
export const frequentCron = '*/10 * * * *';

const frequentJobs = [
	'policy_projections',
	'account_deletions',
	'click_notices',
	'shard_samples'
] as const;
const dailyJobs = [
	'auth_cleanup',
	'routing_maintenance',
	'analytics_purge',
	'limit_notices',
	'deletion_cleanup',
	'operations_purge'
] as const;
type JobName = (typeof frequentJobs)[number] | (typeof dailyJobs)[number];

export const jobs = createJobLedger<JobName>({
	table: 'job_runs',
	frequent: frequentJobs,
	daily: dailyJobs
});

// The frequent run must have finished this recently for /healthz to answer 200.
const healthyWithinMs = 30 * 60 * 1000;

export function deletionDependencies(config: StandaloneConfig): DeletionDependencies {
	// No email in this edition, and no records of its own beyond the core tables.
	return {
		identity: config.identity,
		routing: config.routing,
		shards: config.shards,
		domains: { reservedHostnames: [config.host] }
	};
}

async function retryPolicyProjections(config: StandaloneConfig, now: number): Promise<void> {
	const stores = { routing: config.routing, analytics: config.shards };
	const result = await retryProjections(config.identity, stores, now, 100);
	if (result.failed > 0) throw new Error('Policy projections failed');
}

async function runAccountDeletions(config: StandaloneConfig): Promise<void> {
	const result = await runDeletions(deletionDependencies(config));
	if (result.failed > 0) throw new Error('A deletion step failed');
}

async function recordClickNotices(config: StandaloneConfig, now: number): Promise<void> {
	const result = await reconcileClickNotices(config.identity, config.shards, now);
	if (result.failed > 0) throw new Error('Click notices failed');
}

// One size sample of the analytics database an hour, from the first frequent run of the hour.
async function sampleShards(config: StandaloneConfig, scheduledTime: number): Promise<void> {
	if (new Date(scheduledTime).getUTCMinutes() >= 10) return;
	const measured = await measureShards(config.identity, config.shards, scheduledTime);
	if (measured.some((shard) => shard.sample === null)) throw new Error('Shard sampling failed');
}

async function cleanupAuth(config: StandaloneConfig, now: number): Promise<void> {
	await cleanupOwnerAuthRecords(config.identity, now, 1000);
	await deleteExpiredOAuthRecords(config.identity, now, 1000);
	await deleteExpiredApiTokens(config.identity, now, 1000);
}

async function maintainRouting(config: StandaloneConfig, now: number): Promise<void> {
	await deleteExpiredCreationRecords(config.routing, now, 1000);
}

// Removes aggregates past the retention and receipts past the replay window, in bounded rounds.
async function purgeAnalytics(config: StandaloneConfig, now: number): Promise<void> {
	for (const db of Object.values(config.shards))
		for (let round = 0; round < 20; round += 1)
			if ((await purgeExpired(db, now, 1000)).deleted === 0) break;
}

async function limitNotices(config: StandaloneConfig, now: number): Promise<void> {
	await reconcileLimitNotices(config.identity, config.routing, now);
	await cleanupNotices(config.identity, now);
}

async function purgeOperationRecords(config: StandaloneConfig, now: number): Promise<void> {
	for (let round = 0; round < 20; round += 1)
		if ((await purgeOperations(config.identity, now, 1000)).deleted === 0) break;
}

export async function runScheduled(
	cron: string,
	scheduledTime: number,
	config: StandaloneConfig
): Promise<void> {
	const now = Date.now();
	const run = (list: [JobName, () => Promise<void>][]) =>
		Promise.allSettled(list.map(([job, task]) => jobs.trackJob(config.identity, job, task)));
	const results =
		cron === frequentCron
			? await run([
					['policy_projections', () => retryPolicyProjections(config, now)],
					['account_deletions', () => runAccountDeletions(config)],
					['click_notices', () => recordClickNotices(config, now)],
					['shard_samples', () => sampleShards(config, scheduledTime)]
				])
			: await run([
					['auth_cleanup', () => cleanupAuth(config, now)],
					['routing_maintenance', () => maintainRouting(config, now)],
					['analytics_purge', () => purgeAnalytics(config, now)],
					['limit_notices', () => limitNotices(config, now)],
					['deletion_cleanup', async () => void (await cleanupDeletions(config.identity, now))],
					['operations_purge', () => purgeOperationRecords(config, now)]
				]);
	for (const result of results) if (result.status === 'rejected') throw result.reason;
}

// For an outside uptime monitor: did the frequent run finish in the last 30 minutes?
export async function handleHealthz(request: Request, config: StandaloneConfig): Promise<Response> {
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
