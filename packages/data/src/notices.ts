// SPDX-License-Identifier: AGPL-3.0-only
// Identity-store outbox of notices to workspace owners. A notice is recorded once per dedupe key
// and sent at most once: a send that may have happened is never repeated.
import type { D1Database } from '@cloudflare/workers-types/index.ts';

export type NoticeParams = Record<string, string | number>;

export interface NewNotice {
	tenantId: string;
	kind: string;
	dedupeKey: string;
	params: NoticeParams;
	now: number;
}

export interface ClaimedNotice {
	id: string;
	tenantId: string;
	kind: string;
	params: NoticeParams;
	// The owner's verified email, or null when the workspace has none.
	email: string | null;
}

export type NoticeOutcome = 'sent' | 'delivery_unknown' | 'undeliverable';

// Kept for 62 days, longer than any month, so a monthly dedupe key cannot repeat in its month.
export const noticeLifetimeMs = 62 * 86400000;

function text(value: unknown, field: string): string {
	if (typeof value !== 'string' || !value) throw new Error(`Invalid stored ${field}`);
	return value;
}

function parseParams(value: unknown): NoticeParams {
	const parsed: unknown = JSON.parse(text(value, 'notice params'));
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
		throw new Error('Invalid stored notice params');
	const params: NoticeParams = {};
	for (const [key, item] of Object.entries(parsed)) {
		if (typeof item !== 'string' && typeof item !== 'number')
			throw new Error('Invalid stored notice params');
		params[key] = item;
	}
	return params;
}

// Returns true when this call recorded the notice. A notice for a tenant that does not exist,
// or one already recorded under the key, changes nothing.
export async function recordNotice(db: D1Database, notice: NewNotice): Promise<boolean> {
	const result = await db
		.prepare(
			'INSERT INTO notices (id, tenant_id, kind, dedupe_key, params, created_at) SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM tenants WHERE id = ?) ON CONFLICT(dedupe_key) DO NOTHING'
		)
		.bind(
			crypto.randomUUID(),
			notice.tenantId,
			notice.kind,
			notice.dedupeKey,
			JSON.stringify(notice.params),
			notice.now,
			notice.tenantId
		)
		.run();
	return (result.meta.changes ?? 0) > 0;
}

// One statement claims the oldest pending notices, so concurrent dispatchers never share one.
export async function claimNotices(
	db: D1Database,
	now: number,
	limit: number
): Promise<ClaimedNotice[]> {
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
		throw new Error('Invalid notice batch size');
	const { results } = await db
		.prepare(
			"UPDATE notices SET state = 'sending', claimed_at = ?, attempts = attempts + 1 WHERE id IN (SELECT id FROM notices WHERE state = 'pending' ORDER BY created_at LIMIT ?) RETURNING id, tenant_id, kind, params"
		)
		.bind(now, limit)
		.all<Record<string, unknown>>();
	const notices: ClaimedNotice[] = [];
	for (const row of results) {
		const tenantId = text(row.tenant_id, 'tenant');
		const contact = await db
			.prepare(
				'SELECT u.email FROM tenant_memberships m JOIN "user" u ON u.id = m.user_id WHERE m.tenant_id = ? AND m.role = \'owner\' AND u.emailVerified = 1'
			)
			.bind(tenantId)
			.first<{ email: unknown }>();
		notices.push({
			id: text(row.id, 'notice'),
			tenantId,
			kind: text(row.kind, 'notice kind'),
			params: parseParams(row.params),
			email: typeof contact?.email === 'string' && contact.email ? contact.email : null
		});
	}
	return notices;
}

export async function finishNotice(
	db: D1Database,
	id: string,
	outcome: NoticeOutcome,
	now: number
): Promise<void> {
	await db
		.prepare(
			"UPDATE notices SET state = ?, sent_at = CASE WHEN ? = 'sent' THEN ? ELSE sent_at END WHERE id = ? AND state = 'sending'"
		)
		.bind(outcome, outcome, now, id)
		.run();
}

// A dispatcher that stopped after its claim may have sent the notice, so it is not resent.
export async function abandonStaleNotices(db: D1Database, claimedBefore: number): Promise<number> {
	const result = await db
		.prepare(
			"UPDATE notices SET state = 'delivery_unknown' WHERE state = 'sending' AND claimed_at < ?"
		)
		.bind(claimedBefore)
		.run();
	return result.meta.changes ?? 0;
}

export async function deleteExpiredNotices(
	db: D1Database,
	now: number,
	limit: number
): Promise<number> {
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000)
		throw new Error('Invalid notice batch size');
	const result = await db
		.prepare(
			'DELETE FROM notices WHERE id IN (SELECT id FROM notices WHERE created_at < ? LIMIT ?)'
		)
		.bind(now - noticeLifetimeMs, limit)
		.run();
	return result.meta.changes ?? 0;
}
