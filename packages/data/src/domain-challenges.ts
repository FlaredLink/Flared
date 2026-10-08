// SPDX-License-Identifier: AGPL-3.0-only
// Challenges that prove a hostname reaches a standalone Worker. Each claim of a hostname has its
// own; the claim time keeps a challenge of an earlier claim from counting.
import type { D1Database } from '@cloudflare/workers-types/index.ts';

export interface DomainChallenge {
	challenge: string;
	consumed: boolean;
}

export interface ChallengeClaim {
	domainId: string;
	claimedAt: number;
}

function toChallenge(row: Record<string, unknown> | null): DomainChallenge | null {
	if (!row) return null;
	if (typeof row.challenge !== 'string') throw new Error('Invalid stored domain challenge');
	return { challenge: row.challenge, consumed: row.consumed_at !== null };
}

// Creates the claim's challenge once; a repeat keeps the first value.
export async function ensureDomainChallenge(
	db: D1Database,
	claim: ChallengeClaim & { challenge: string; expiresAt: number }
): Promise<DomainChallenge> {
	const row = await db
		.prepare(
			`INSERT INTO domain_challenges (domain_id, claimed_at, challenge, expires_at) VALUES (?, ?, ?, ?)
			ON CONFLICT(domain_id, claimed_at) DO UPDATE SET domain_id = excluded.domain_id
			RETURNING challenge, consumed_at`
		)
		.bind(claim.domainId, claim.claimedAt, claim.challenge, claim.expiresAt)
		.first<Record<string, unknown>>();
	const stored = toChallenge(row);
	if (!stored) throw new Error('The domain challenge was not stored');
	return stored;
}

export async function consumeDomainChallenge(
	db: D1Database,
	claim: ChallengeClaim,
	now: number
): Promise<void> {
	await db
		.prepare(
			'UPDATE domain_challenges SET consumed_at = ? WHERE domain_id = ? AND claimed_at = ? AND consumed_at IS NULL'
		)
		.bind(now, claim.domainId, claim.claimedAt)
		.run();
}

// The challenge to serve on a hostname: only for the current claim of a workspace domain that
// is still waiting, before the claim and the challenge expire, and before it is used.
export async function servableDomainChallenge(
	db: D1Database,
	hostname: string,
	now: number
): Promise<string | null> {
	const row = await db
		.prepare(
			`SELECT c.challenge FROM domain_namespaces n
			JOIN domains d ON d.id = n.id
			JOIN domain_challenges c ON c.domain_id = d.id AND c.claimed_at = d.claimed_at
			WHERE n.hostname = ?1 AND d.tenant_id IS NOT NULL
				AND d.state IN ('pending','verifying','failed') AND d.claim_expires_at > ?2
				AND c.consumed_at IS NULL AND c.expires_at > ?2`
		)
		.bind(hostname, now)
		.first<Record<string, unknown>>();
	return typeof row?.challenge === 'string' ? row.challenge : null;
}

export async function deleteDomainChallenges(db: D1Database, domainId: string): Promise<void> {
	await db.prepare('DELETE FROM domain_challenges WHERE domain_id = ?').bind(domainId).run();
}

// For a scheduled check: workspace domains that wait for their first proof, least recently
// fetched first.
export async function waitingDomains(
	db: D1Database,
	now: number,
	limit: number
): Promise<{ id: string; hostname: string; claimedAt: number }[]> {
	const { results } = await db
		.prepare(
			`SELECT d.id, n.hostname, d.claimed_at FROM domains d
			JOIN domain_namespaces n ON n.id = d.id
			LEFT JOIN domain_challenges c ON c.domain_id = d.id AND c.claimed_at = d.claimed_at
			WHERE d.tenant_id IS NOT NULL AND d.state IN ('pending','verifying','failed')
				AND d.claimed_at IS NOT NULL AND d.claim_expires_at > ?
			ORDER BY COALESCE(c.checked_at, 0), d.claimed_at LIMIT ?`
		)
		.bind(now, limit)
		.all<Record<string, unknown>>();
	return results.map((row) => {
		if (
			typeof row.id !== 'string' ||
			typeof row.hostname !== 'string' ||
			typeof row.claimed_at !== 'number'
		)
			throw new Error('Invalid stored domain');
		return { id: row.id, hostname: row.hostname, claimedAt: row.claimed_at };
	});
}

export async function markDomainChallengeFetched(
	db: D1Database,
	claim: ChallengeClaim,
	now: number
): Promise<void> {
	await db
		.prepare('UPDATE domain_challenges SET checked_at = ? WHERE domain_id = ? AND claimed_at = ?')
		.bind(now, claim.domainId, claim.claimedAt)
		.run();
}

// Removes challenges past their expiry, used or not, in one bounded round.
export async function deleteExpiredDomainChallenges(
	db: D1Database,
	now: number,
	limit: number
): Promise<number> {
	const result = await db
		.prepare(
			'DELETE FROM domain_challenges WHERE rowid IN (SELECT rowid FROM domain_challenges WHERE expires_at <= ? LIMIT ?)'
		)
		.bind(now, limit)
		.run();
	return result.meta.changes ?? 0;
}
