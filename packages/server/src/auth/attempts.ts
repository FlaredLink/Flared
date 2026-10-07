// SPDX-License-Identifier: AGPL-3.0-only
// Budgets for the standalone password routes and setup, in identity table auth_attempts. Each
// attempt is reserved in one conditional insert before any password hash runs, so parallel
// requests cannot pass a limit. A denied attempt stores nothing.
import type { D1Database } from '@cloudflare/workers-types/index.ts';

export type AttemptKind = 'sign_in' | 'reauth' | 'password_change' | 'setup';

export interface AttemptWindow {
	limit: number;
	windowMs: number;
}

export interface AttemptBudget {
	// Per key: an HMAC of the request source or of the user.
	perKey: AttemptWindow;
	// Across all keys of the kind.
	total?: AttemptWindow;
}

const minute = 60000;
const hour = 3600000;

export const ownerBudgets: Record<AttemptKind, AttemptBudget> = {
	sign_in: {
		perKey: { limit: 10, windowMs: 15 * minute },
		total: { limit: 100, windowMs: hour }
	},
	reauth: { perKey: { limit: 5, windowMs: 15 * minute } },
	password_change: { perKey: { limit: 5, windowMs: 15 * minute } },
	setup: {
		perKey: { limit: 5, windowMs: 15 * minute },
		total: { limit: 30, windowMs: hour }
	}
};

// Rows older than the longest window no longer count.
export const attemptRetentionMs = hour;

function checkWindow(window: AttemptWindow): void {
	if (
		!Number.isSafeInteger(window.limit) ||
		window.limit < 1 ||
		!Number.isSafeInteger(window.windowMs) ||
		window.windowMs < 1 ||
		window.windowMs > attemptRetentionMs
	)
		throw new Error('Invalid attempt budget');
}

export async function reserveAttempt(
	db: D1Database,
	kind: AttemptKind,
	key: string,
	now: number,
	budget: AttemptBudget = ownerBudgets[kind]
): Promise<{ allowed: boolean; retryAfter: number }> {
	if (!Number.isSafeInteger(now) || !key) throw new Error('Invalid attempt');
	checkWindow(budget.perKey);
	const total = budget.total ?? null;
	if (total) checkWindow(total);
	const keyCutoff = now - budget.perKey.windowMs;
	const totalCutoff = total ? now - total.windowMs : now;
	const reserved = await db
		.prepare(
			`INSERT INTO auth_attempts (id, kind, key, created_at)
 SELECT ?1, ?2, ?3, ?4 WHERE
 (SELECT COUNT(*) FROM auth_attempts WHERE kind = ?2 AND key = ?3 AND created_at > ?5) < ?6
 AND (?8 = 0 OR (SELECT COUNT(*) FROM auth_attempts WHERE kind = ?2 AND created_at > ?7) < ?8)
 RETURNING id`
		)
		.bind(
			crypto.randomUUID(),
			kind,
			key,
			now,
			keyCutoff,
			budget.perKey.limit,
			totalCutoff,
			total?.limit ?? 0
		)
		.first<{ id: string }>();
	if (reserved) return { allowed: true, retryAfter: 0 };
	const row = await db
		.prepare(
			`SELECT
 (SELECT COUNT(*) FROM auth_attempts WHERE kind = ?1 AND key = ?2 AND created_at > ?3) AS key_count,
 (SELECT MIN(created_at) FROM auth_attempts WHERE kind = ?1 AND key = ?2 AND created_at > ?3) AS key_first,
 (SELECT COUNT(*) FROM auth_attempts WHERE kind = ?1 AND created_at > ?4) AS total_count,
 (SELECT MIN(created_at) FROM auth_attempts WHERE kind = ?1 AND created_at > ?4) AS total_first`
		)
		.bind(kind, key, keyCutoff, totalCutoff)
		.first<{
			key_count: number;
			key_first: number | null;
			total_count: number;
			total_first: number | null;
		}>();
	if (!row) throw new Error('Attempt budget unavailable');
	let release = now;
	if (row.key_count >= budget.perKey.limit && row.key_first !== null)
		release = Math.max(release, row.key_first + budget.perKey.windowMs);
	if (total && row.total_count >= total.limit && row.total_first !== null)
		release = Math.max(release, row.total_first + total.windowMs);
	return { allowed: false, retryAfter: Math.max(1, Math.ceil((release - now) / 1000)) };
}

// Removes attempts that no longer count, in a bounded batch.
export async function deleteExpiredAttempts(
	db: D1Database,
	now: number,
	limit: number
): Promise<void> {
	if (!Number.isSafeInteger(now) || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
		throw new Error('Invalid attempt cleanup bounds');
	await db
		.prepare(
			'DELETE FROM auth_attempts WHERE id IN (SELECT id FROM auth_attempts WHERE created_at <= ? ORDER BY created_at LIMIT ?)'
		)
		.bind(now - attemptRetentionMs, limit)
		.run();
}
