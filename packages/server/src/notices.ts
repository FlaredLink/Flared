// SPDX-License-Identifier: AGPL-3.0-only
// Usage notices at 80% and 100% of a limit, and the dispatcher that emails recorded notices.
// Click notices come from a periodic check of each shard; link and domain notices are recorded
// after a creation and by a daily check, which also covers lowered limits.
import type { D1Database } from '@cloudflare/workers-types/index.ts';
import { usageLevel, utcMonth, type UsageResource } from '@flared/contracts/analytics';
import { listHighClickUsage } from '@flared/data/analytics';
import {
	abandonStaleNotices,
	claimNotices,
	deleteExpiredNotices,
	finishNotice,
	recordNotice,
	type ClaimedNotice
} from '@flared/data/notices';
import { listLimitUsage, readLimitUsage, type LimitUsage } from '@flared/data/routing-policy';
import type { EmailContent, EmailTransport } from './email/transport';
import type { AnalyticsShards } from './shards';

export const usageNoticeKind = 'usage';

const pageSize = 200;
// At most this many pages per store and run; the next run continues with the rest.
const maxPages = 25;
const staleClaimMs = 15 * 60000;

async function recordUsage(
	identity: D1Database,
	tenantId: string,
	resource: UsageResource,
	period: string,
	used: number,
	limit: number,
	now: number
): Promise<boolean> {
	const level = usageLevel(used, limit);
	if (!level) return false;
	return recordNotice(identity, {
		tenantId,
		kind: usageNoticeKind,
		dedupeKey: `${usageNoticeKind}:${resource}:${tenantId}:${period}:${level}`,
		params: { resource, level, used, limit, period },
		now
	});
}

// Records the notices for each tenant at 80% or more of its click allowance this month.
// Only the highest threshold reached is recorded, so a jump past both sends one notice.
export async function reconcileClickNotices(
	identity: D1Database,
	shards: AnalyticsShards,
	now: number
): Promise<{ recorded: number; failed: number }> {
	const month = utcMonth(now);
	let recorded = 0;
	let failed = 0;
	for (const [shardId, shard] of Object.entries(shards)) {
		try {
			let after = '';
			for (let page = 0; page < maxPages; page += 1) {
				const rows = await listHighClickUsage(shard, month, after, pageSize);
				for (const row of rows)
					if (
						await recordUsage(
							identity,
							row.tenantId,
							'clicks',
							month,
							row.clicks,
							row.monthlyClickLimit,
							now
						)
					)
						recorded += 1;
				if (rows.length < pageSize) break;
				after = rows[rows.length - 1].tenantId;
			}
		} catch {
			failed += 1;
			console.error(JSON.stringify({ event: 'click_notices_failed', shardId }));
		}
	}
	return { recorded, failed };
}

// A new policy revision starts new link and domain thresholds, so a lowered limit warns again.
async function recordLimits(identity: D1Database, usage: LimitUsage, now: number) {
	const period = `r${usage.revision}`;
	let recorded = 0;
	for (const resource of ['links', 'domains'] as const) {
		const { used, limit } = usage[resource];
		if (await recordUsage(identity, usage.tenantId, resource, period, used, limit, now))
			recorded += 1;
	}
	return recorded;
}

// Called after a link or domain is created. A failure is logged and never fails the creation;
// the daily check records what was missed.
export async function noteLimitUsage(
	identity: D1Database,
	routing: D1Database,
	tenantId: string,
	now: number
): Promise<void> {
	try {
		const usage = await readLimitUsage(routing, tenantId);
		if (usage) await recordLimits(identity, usage, now);
	} catch {
		console.error(JSON.stringify({ event: 'limit_notice_failed' }));
	}
}

export async function reconcileLimitNotices(
	identity: D1Database,
	routing: D1Database,
	now: number
): Promise<{ recorded: number }> {
	let recorded = 0;
	let after = '';
	for (let page = 0; page < maxPages; page += 1) {
		const rows = await listLimitUsage(routing, after, pageSize);
		for (const usage of rows) recorded += await recordLimits(identity, usage, now);
		if (rows.length < pageSize) break;
		after = rows[rows.length - 1].tenantId;
	}
	return { recorded };
}

function escape(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;');
}

function nextMonth(period: string): string {
	const [year, month] = period.split('-').map(Number);
	return new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
}

const nouns: Record<UsageResource, string> = {
	clicks: 'monthly clicks',
	links: 'active links',
	domains: 'custom domains'
};

// The email for a usage notice, or null for a notice of another kind or with bad params.
// usageUrl is where the owner sees usage, such as https://example.com/app.
export function usageNoticeEmail(
	notice: ClaimedNotice,
	to: string,
	usageUrl: string
): EmailContent | null {
	if (notice.kind !== usageNoticeKind) return null;
	const { resource, level, used, limit, period } = notice.params;
	if (resource !== 'clicks' && resource !== 'links' && resource !== 'domains') return null;
	if ((level !== 80 && level !== 100) || typeof used !== 'number' || typeof limit !== 'number')
		return null;
	if (typeof period !== 'string') return null;
	const full = level === 100;
	let subject: string;
	let lines: string[];
	if (resource === 'clicks') {
		subject = full
			? 'Your Flared workspace reached its monthly click limit'
			: 'Your Flared workspace used 80% of its monthly clicks';
		lines = full
			? [
					`Your workspace recorded ${limit} clicks in ${period} (UTC), which is its limit.`,
					`Your links keep redirecting, but new clicks are not recorded until ${nextMonth(period)} or until the limit rises.`
				]
			: [
					`Your workspace recorded ${used} of ${limit} clicks in ${period} (UTC).`,
					'At the limit, your links keep redirecting, but new clicks are not recorded until the next month.'
				];
	} else {
		const noun = nouns[resource];
		const action = resource === 'links' ? 'create or turn on more links' : 'add more domains';
		subject = full
			? `Your Flared workspace reached its limit of ${noun}`
			: `Your Flared workspace used 80% of its ${noun}`;
		lines = [
			`Your workspace uses ${used} of ${limit} ${noun}.`,
			full
				? `You cannot ${action} until the limit rises. Existing ${resource} keep working.`
				: `At the limit, you cannot ${action}. Existing ${resource} keep working.`
		];
	}
	return {
		to,
		subject,
		text: `${lines.join('\n\n')}\n\nSee usage: ${usageUrl}`,
		html: `${lines.map((line) => `<p>${escape(line)}</p>`).join('')}<p><a href="${escape(usageUrl)}">See usage</a></p>`
	};
}

export interface NoticeDispatch {
	identity: D1Database;
	transport: EmailTransport;
	// Returns the email for a notice, or null when no template knows its kind.
	render(notice: ClaimedNotice, to: string): EmailContent | null;
	now: number;
	limit?: number;
}

// Sends claimed notices once. A failed send may still have been delivered, so it becomes
// delivery_unknown for an operator to check; it is never sent again automatically.
export async function dispatchNotices(
	dispatch: NoticeDispatch
): Promise<Record<'sent' | 'delivery_unknown' | 'undeliverable', number>> {
	const { identity, now } = dispatch;
	const counts = { sent: 0, delivery_unknown: 0, undeliverable: 0 };
	const abandoned = await abandonStaleNotices(identity, now - staleClaimMs);
	counts.delivery_unknown += abandoned;
	for (const notice of await claimNotices(identity, now, dispatch.limit ?? 25)) {
		const email = notice.email ? dispatch.render(notice, notice.email) : null;
		if (!email) {
			console.error(
				JSON.stringify({ event: 'notice_undeliverable', kind: notice.kind, noticeId: notice.id })
			);
			await finishNotice(identity, notice.id, 'undeliverable', now);
			counts.undeliverable += 1;
			continue;
		}
		let outcome: 'sent' | 'delivery_unknown' = 'sent';
		try {
			await dispatch.transport.send(email);
		} catch {
			outcome = 'delivery_unknown';
			console.error(JSON.stringify({ event: 'notice_delivery_unknown', noticeId: notice.id }));
		}
		await finishNotice(identity, notice.id, outcome, now);
		counts[outcome] += 1;
	}
	return counts;
}

export async function cleanupNotices(identity: D1Database, now: number): Promise<number> {
	let deleted = 0;
	for (let page = 0; page < maxPages; page += 1) {
		const count = await deleteExpiredNotices(identity, now, 1000);
		deleted += count;
		if (count < 1000) break;
	}
	return deleted;
}
