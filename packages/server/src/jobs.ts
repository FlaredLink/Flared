// SPDX-License-Identifier: AGPL-3.0-only
// The outcome of each scheduled job, for health checks. Each edition names its jobs and the
// table that holds one row per job, with the columns job, last_started_at, last_finished_at,
// last_outcome, last_success_at, and failures.
import type { D1Database } from '@cloudflare/workers-types/index.ts';
import { checkedTableName } from './auth/limits';

export const frequentJobMs = 10 * 60 * 1000;
export const dailyJobMs = 86400000;
// A run may start a few minutes late; a job is missed after two intervals and this margin.
const missedMarginMs = 5 * 60 * 1000;

export interface JobStatus<Name extends string> {
	job: Name;
	intervalMs: number;
	lastFinishedAt: number | null;
	lastOutcome: 'succeeded' | 'failed' | null;
	lastSuccessAt: number | null;
	failures: number;
	// The job has run before but not within two intervals. A job without a run is not missed:
	// a daily job has no run for up to a day after a deploy that adds it.
	missed: boolean;
}

function optionalCount(value: unknown): number | null {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function createJobLedger<Name extends string>(options: {
	table: string;
	// Jobs of the 10-minute cron and of the daily cron.
	frequent: readonly Name[];
	daily: readonly Name[];
}) {
	const table = checkedTableName(options.table);
	const { frequent, daily } = options;

	function jobIntervalMs(job: Name): number {
		return frequent.some((name) => name === job) ? frequentJobMs : dailyJobMs;
	}

	function isJobName(value: unknown): value is Name {
		return frequent.some((name) => name === value) || daily.some((name) => name === value);
	}

	async function recordJobRun(
		identity: D1Database,
		job: Name,
		startedAt: number,
		finishedAt: number,
		failed: boolean
	): Promise<void> {
		await identity
			.prepare(
				`INSERT INTO ${table} (job, last_started_at, last_finished_at, last_outcome, last_success_at, failures)
			VALUES (?1, ?2, ?3, ?4, CASE WHEN ?4 = 'succeeded' THEN ?3 END, CASE WHEN ?4 = 'failed' THEN 1 ELSE 0 END)
			ON CONFLICT(job) DO UPDATE SET last_started_at = excluded.last_started_at,
			last_finished_at = excluded.last_finished_at, last_outcome = excluded.last_outcome,
			last_success_at = COALESCE(excluded.last_success_at, ${table}.last_success_at),
			failures = CASE WHEN excluded.last_outcome = 'failed' THEN ${table}.failures + 1 ELSE 0 END`
			)
			.bind(job, startedAt, finishedAt, failed ? 'failed' : 'succeeded')
			.run();
	}

	// Runs a job and records its outcome. A failed record never hides the job's own result.
	async function trackJob(
		identity: D1Database | null,
		job: Name,
		run: () => Promise<void>,
		now: () => number = Date.now
	): Promise<void> {
		const startedAt = now();
		let failed = false;
		try {
			await run();
		} catch (error) {
			failed = true;
			throw error;
		} finally {
			if (identity)
				await recordJobRun(identity, job, startedAt, now(), failed).catch(() =>
					console.error(JSON.stringify({ event: 'job_status_failed', job }))
				);
		}
	}

	async function readJobStatuses(identity: D1Database, now: number): Promise<JobStatus<Name>[]> {
		const { results } = await identity
			.prepare(
				`SELECT job, last_finished_at, last_outcome, last_success_at, failures FROM ${table}`
			)
			.all<Record<string, unknown>>();
		const rows = new Map(results.map((row) => [row.job, row]));
		return [...frequent, ...daily].map((job) => {
			const row = rows.get(job);
			const intervalMs = jobIntervalMs(job);
			const lastFinishedAt = optionalCount(row?.last_finished_at);
			const outcome = row?.last_outcome;
			return {
				job,
				intervalMs,
				lastFinishedAt,
				lastOutcome: outcome === 'succeeded' || outcome === 'failed' ? outcome : null,
				lastSuccessAt: optionalCount(row?.last_success_at),
				failures: optionalCount(row?.failures) ?? 0,
				missed: lastFinishedAt !== null && now - lastFinishedAt > 2 * intervalMs + missedMarginMs
			};
		});
	}

	return { jobIntervalMs, isJobName, recordJobRun, trackJob, readJobStatuses };
}
