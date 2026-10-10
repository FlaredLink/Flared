// SPDX-License-Identifier: AGPL-3.0-only
// Workspace deletion: the request ends every credential at once, then a resumable job stops the
// redirects, waits out the redirect snapshots, and deletes the analytics, routing, and identity
// records in bounded steps. Slug reservations stay, so a deleted address is never reused.
import type { D1Database } from '@cloudflare/workers-types/index.ts';
import {
	claimDeletions,
	completeDeletion,
	createDeletion,
	deleteAnalyticsData,
	deleteExpiredDeletions,
	deleteIdentityRecords,
	deleteRoutingData,
	deleteRoutingPolicy,
	failDeletion,
	saveDeletion,
	tombstoneTenant,
	type DeletionJob,
	type DeletionStep
} from '@flared/data/deletions';
import { listDomains } from '@flared/data/domains';
import { readTenantShard } from '@flared/data/tenancy';
import { removeDomain, type DomainSettings } from './domains';
import type { EmailContent, EmailTransport } from './email/transport';
import { resolveShard, type AnalyticsShards } from './shards';
import { resolveTenant } from './tenancy';

// Past the 60-second lifetime of a redirect snapshot, with room for a slow fill.
export const routeSettleMs = 70_000;
const rowsPerBatch = 1000;
const batchesPerRun = 20;
const stepsPerRun = 12;

export interface DeletionEmail {
	transport: EmailTransport;
}

export interface DeletionDependencies {
	identity: D1Database;
	routing: D1Database;
	shards: AnalyticsShards;
	domains: DomainSettings;
	// Without it, the job sends no email; standalone defaults to none.
	email?: DeletionEmail;
	// An edition's own records of the tenant and user, deleted before the identity records.
	// Must be safe to repeat.
	extension?: (job: { tenantId: string; userId: string }) => Promise<void>;
	now?: () => number;
}

export type DeletionRequest =
	| { status: 'started'; tenantId: string }
	| { status: 'already_deleting'; tenantId: string }
	// The operator suspended the workspace; it cannot be deleted until it is reinstated.
	| { status: 'suspended'; tenantId: string }
	| { status: 'no_workspace' };

// Starts the deletion of one of the user's workspaces. The caller has checked the session, a
// recent sign-in, the owner role, the confirmation, and its own conditions. Safe to repeat.
export async function requestDeletion(
	identity: D1Database,
	request: { userId: string; tenantId: string },
	now: number
): Promise<DeletionRequest> {
	const { userId } = request;
	const tenant = await resolveTenant(identity, request);
	if (tenant.status === 'none') return { status: 'no_workspace' };
	if (tenant.status === 'deleting')
		return { status: 'already_deleting', tenantId: tenant.tenantId };
	if (tenant.status === 'active' && tenant.suspension)
		return { status: 'suspended', tenantId: tenant.tenantId };
	const shardId = await readTenantShard(identity, tenant.tenantId);
	const user = await identity
		.prepare('SELECT "email", "emailVerified" FROM "user" WHERE "id" = ?')
		.bind(userId)
		.first<{ email: unknown; emailVerified: unknown }>();
	if (!shardId || !user) return { status: 'no_workspace' };
	// Only a verified address receives the deletion emails.
	const contact = user.emailVerified === 1 && typeof user.email === 'string' ? user.email : null;
	const created = await createDeletion(identity, {
		tenantId: tenant.tenantId,
		userId,
		analyticsShardId: shardId,
		contactEmail: contact,
		now
	});
	if (!created) {
		// A concurrent request started the deletion, or a suspension landed after the check.
		const current = await resolveTenant(identity, request);
		return current.status === 'deleting'
			? { status: 'already_deleting', tenantId: tenant.tenantId }
			: { status: 'suspended', tenantId: tenant.tenantId };
	}
	console.log(JSON.stringify({ event: 'deletion_requested', tenantId: tenant.tenantId }));
	return { status: 'started', tenantId: tenant.tenantId };
}

function escape(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

// The request already needed a recent sign-in and the typed confirmation, and a deletion cannot
// be undone, so the emails only report progress.
export function deletionEmail(kind: 'accepted' | 'completed', to: string): EmailContent {
	const content =
		kind === 'accepted'
			? {
					subject: 'We are deleting your Flared account',
					lines: [
						'We received the request to delete your Flared account. Your short links no longer redirect, and every sign-in, API token, and connected app has stopped working.',
						'We are now removing your links, domains, and analytics. We will email you again when the deletion is complete.'
					]
				}
			: {
					subject: 'Your Flared account is deleted',
					lines: [
						'Your Flared account, links, domains, and analytics are deleted.',
						'The short-link addresses you used stay reserved, so no one else can use them. These reservations hold no account details or destinations.',
						'You can sign up again with this email address at any time.'
					]
				};
	return {
		to,
		subject: content.subject,
		text: content.lines.join('\n\n'),
		html: content.lines.map((line) => `<p>${escape(line)}</p>`).join('')
	};
}

// Each email is sent once. A failed send may still have arrived, so it is never repeated.
async function notify(
	deps: DeletionDependencies,
	job: DeletionJob,
	kind: 'accepted' | 'completed'
): Promise<void> {
	if (!deps.email || !job.contactEmail) return;
	try {
		await deps.email.transport.send(deletionEmail(kind, job.contactEmail));
	} catch {
		console.error(
			JSON.stringify({ event: 'deletion_email_unknown', kind, tenantId: job.tenantId })
		);
	}
}

// Runs the job's steps until it waits, runs out of work for this run, or completes.
async function advance(deps: DeletionDependencies, job: DeletionJob): Promise<boolean> {
	const now = deps.now ?? Date.now;
	const { identity, routing } = deps;
	const { tenantId } = job;
	let step: DeletionStep = job.step;
	let routesStoppedAt = job.routesStoppedAt;
	// at: when the job runs again. Without it, the claim's backoff stays in place.
	const save = (next: DeletionStep, at?: number) =>
		saveDeletion(identity, tenantId, {
			step: next,
			...(at === undefined ? {} : { next: at }),
			...(routesStoppedAt === null ? {} : { routesStoppedAt })
		});
	// Deletes in batches until none is left. Returns false when work remains for the next run.
	const drain = async (remove: () => Promise<number>) => {
		for (let batch = 0; batch < batchesPerRun; batch += 1) if ((await remove()) === 0) return true;
		return false;
	};

	for (let run = 0; run < stepsPerRun; run += 1) {
		let next: DeletionStep;
		switch (step) {
			case 'accepted':
				await notify(deps, job, 'accepted');
				next = 'routing';
				break;
			case 'routing': {
				await deleteRoutingPolicy(routing, tenantId);
				for (const domain of await listDomains(routing, tenantId))
					if (domain.tenantId === tenantId)
						try {
							await removeDomain(routing, deps.domains, {
								tenantId,
								domainId: domain.id,
								now: now()
							});
						} catch {
							console.error(JSON.stringify({ event: 'deletion_domain_failed', tenantId }));
						}
				routesStoppedAt ??= now();
				next = 'wait';
				break;
			}
			case 'wait': {
				const settled = (routesStoppedAt ?? 0) + routeSettleMs;
				if (now() < settled) {
					await save('wait', settled);
					return false;
				}
				next = 'analytics';
				break;
			}
			case 'analytics': {
				const shard = resolveShard(deps.shards, job.analyticsShardId);
				await tombstoneTenant(shard, tenantId, now());
				if (!(await drain(() => deleteAnalyticsData(shard, tenantId, rowsPerBatch)))) {
					await save('analytics', now());
					return false;
				}
				next = 'routing_data';
				break;
			}
			case 'routing_data':
				if (!(await drain(() => deleteRoutingData(routing, tenantId, rowsPerBatch)))) {
					await save('routing_data', now());
					return false;
				}
				next = 'extension';
				break;
			case 'extension':
				await deps.extension?.({ tenantId, userId: job.userId });
				next = 'identity';
				break;
			case 'identity':
				await deleteIdentityRecords(identity, tenantId, job.userId, now());
				next = 'completed_notice';
				break;
			case 'completed_notice':
				await notify(deps, job, 'completed');
				await completeDeletion(identity, tenantId, now());
				console.log(JSON.stringify({ event: 'deletion_completed', tenantId }));
				return true;
			case 'done':
				return true;
		}
		step = next;
		await save(step);
	}
	await save(step, now());
	return false;
}

// For a scheduled run, or one tenant right after its request. Returns completed and failed jobs.
export async function runDeletions(
	deps: DeletionDependencies,
	options: { limit?: number; tenantId?: string } = {}
): Promise<{ completed: number; failed: number }> {
	const now = deps.now ?? Date.now;
	const counts = { completed: 0, failed: 0 };
	const jobs = await claimDeletions(
		deps.identity,
		now(),
		options.limit ?? 5,
		options.tenantId ?? null
	);
	for (const job of jobs)
		try {
			if (await advance(deps, job)) counts.completed += 1;
		} catch (error) {
			counts.failed += 1;
			const code = error instanceof Error ? error.name : 'deletion_failed';
			console.error(
				JSON.stringify({ event: 'deletion_step_failed', tenantId: job.tenantId, code })
			);
			await failDeletion(deps.identity, job.tenantId, code.slice(0, 64));
		}
	return counts;
}

// Daily: the ledger of completed deletions expires after 90 days.
export async function cleanupDeletions(identity: D1Database, now: number): Promise<number> {
	return deleteExpiredDeletions(identity, now);
}
