// SPDX-License-Identifier: AGPL-3.0-only
// Routing-store records for short-link domains. A state changes only through
// applyDomainEvidence, which takes a provider's result; no request can set a state.
import type { D1Database } from '@cloudflare/workers-types/index.ts';
import {
	domainStates,
	isDomainFailure,
	type DomainFailure,
	type DomainState
} from '@flared/contracts/domains';

export interface DomainRecord {
	id: string;
	hostname: string;
	// Null for a platform domain.
	tenantId: string | null;
	state: DomainState;
	isDefault: boolean;
	failureCode: DomainFailure | null;
	activeLinks: number;
	createdAt: number;
	claimedAt: number | null;
	claimExpiresAt: number | null;
	activatedAt: number | null;
	checkedAt: number | null;
}

// waiting: no DNS record yet. verifying: the record is seen; the certificate is pending.
// ready: serves traffic. failed: the provider gave up or the record is gone.
export type DomainEvidence =
	| { status: 'waiting' }
	| { status: 'verifying' }
	| { status: 'ready' }
	| { status: 'failed'; code: DomainFailure };

export type ClaimOutcome =
	| { outcome: 'claimed'; domain: DomainRecord }
	| { outcome: 'existing'; domain: DomainRecord }
	| { outcome: 'taken' }
	| { outcome: 'limit_reached' }
	| { outcome: 'unavailable' };

const columns = `d.id, n.hostname, d.tenant_id, d.state, d.is_default, d.failure_code, d.created_at,
	d.claimed_at, d.claim_expires_at, d.activated_at, d.checked_at,
	(SELECT COUNT(*) FROM links l WHERE l.domain_id = d.id AND l.status = 'active' AND l.tenant_id = d.tenant_id) AS active_links`;

function integer(value: unknown, field: string): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value))
		throw new Error(`Invalid stored ${field}`);
	return value;
}

function optionalInteger(value: unknown, field: string): number | null {
	return value === null ? null : integer(value, field);
}

function toDomain(row: Record<string, unknown>): DomainRecord {
	if (typeof row.id !== 'string' || typeof row.hostname !== 'string')
		throw new Error('Invalid stored domain');
	if (row.tenant_id !== null && typeof row.tenant_id !== 'string')
		throw new Error('Invalid stored domain tenant');
	if (!(domainStates as readonly unknown[]).includes(row.state))
		throw new Error('Invalid stored domain state');
	return {
		id: row.id,
		hostname: row.hostname,
		tenantId: row.tenant_id,
		state: row.state as DomainState,
		isDefault: row.is_default === 1,
		failureCode: isDomainFailure(row.failure_code) ? row.failure_code : null,
		activeLinks: integer(row.active_links, 'link count'),
		createdAt: integer(row.created_at, 'creation time'),
		claimedAt: optionalInteger(row.claimed_at, 'claim time'),
		claimExpiresAt: optionalInteger(row.claim_expires_at, 'claim expiry'),
		activatedAt: optionalInteger(row.activated_at, 'activation time'),
		checkedAt: optionalInteger(row.checked_at, 'check time')
	};
}

// Active platform domains, then the workspace's domains that are not removed. Bounded by the
// domain limit, so no pagination.
export async function listDomains(db: D1Database, tenantId: string): Promise<DomainRecord[]> {
	const { results } = await db
		.prepare(
			`SELECT ${columns} FROM domains d JOIN domain_namespaces n ON n.id = d.id
			WHERE (d.tenant_id IS NULL AND d.state = 'active') OR (d.tenant_id = ? AND d.state != 'disabled')
			ORDER BY d.tenant_id IS NOT NULL, d.created_at, d.id LIMIT 200`
		)
		.bind(tenantId)
		.all<Record<string, unknown>>();
	return results.map(toDomain);
}

export async function findDomain(
	db: D1Database,
	tenantId: string,
	domainId: string
): Promise<DomainRecord | null> {
	const row = await db
		.prepare(
			`SELECT ${columns} FROM domains d JOIN domain_namespaces n ON n.id = d.id
			WHERE d.id = ? AND ((d.tenant_id IS NULL AND d.state = 'active') OR (d.tenant_id = ? AND d.state != 'disabled'))`
		)
		.bind(domainId, tenantId)
		.first<Record<string, unknown>>();
	return row ? toDomain(row) : null;
}

export async function domainUsage(
	db: D1Database,
	tenantId: string
): Promise<{ used: number; limit: number } | null> {
	const row = await db
		.prepare(
			"SELECT domain_limit, (SELECT COUNT(*) FROM domains WHERE tenant_id = ?1 AND state != 'disabled') AS used FROM tenant_policy WHERE tenant_id = ?1"
		)
		.bind(tenantId)
		.first<Record<string, unknown>>();
	return row
		? { used: integer(row.used, 'domain count'), limit: integer(row.domain_limit, 'domain limit') }
		: null;
}

// One batch: keep the hostname's permanent namespace, then insert the claim or take over a
// removed or expired one, within the limit. A platform domain and another workspace's live
// claim never change hands. Batches run one at a time, so the limit holds under concurrency.
export async function claimDomain(
	db: D1Database,
	claim: { tenantId: string; hostname: string; newId: string; now: number; expiresAt: number }
): Promise<ClaimOutcome> {
	const { tenantId, hostname, newId, now, expiresAt } = claim;
	const existing = await findClaim(db, hostname);
	const expired =
		existing !== null &&
		existing.state !== 'active' &&
		existing.claimExpiresAt !== null &&
		existing.claimExpiresAt <= now;
	if (existing && existing.tenantId === tenantId && existing.state !== 'disabled' && !expired) {
		const domain = await findDomain(db, tenantId, existing.id);
		if (domain) return { outcome: 'existing', domain };
	}
	await db.batch([
		db
			.prepare(
				'INSERT OR IGNORE INTO domain_namespaces (id, hostname, created_at) VALUES (?, ?, ?)'
			)
			.bind(newId, hostname, now),
		db
			.prepare(
				`INSERT INTO domains (id, tenant_id, state, is_default, created_at, updated_at, claimed_at, claim_expires_at)
				SELECT n.id, ?1, 'pending', 0, ?3, ?3, ?3, ?4 FROM domain_namespaces n
				WHERE n.hostname = ?2
				AND (SELECT COUNT(*) FROM domains WHERE tenant_id = ?1 AND state != 'disabled')
					< (SELECT domain_limit FROM tenant_policy WHERE tenant_id = ?1)
				ON CONFLICT(id) DO UPDATE SET tenant_id = ?1, state = 'pending', updated_at = ?3,
					claimed_at = ?3, claim_expires_at = ?4, activated_at = NULL, failure_code = NULL,
					checked_at = NULL
				WHERE domains.tenant_id IS NOT NULL AND (domains.state = 'disabled'
					OR (domains.state IN ('pending','verifying','failed') AND domains.claim_expires_at <= ?3))`
			)
			.bind(tenantId, hostname, now, expiresAt)
	]);
	const after = await findClaim(db, hostname);
	if (after && after.tenantId === tenantId && after.claimedAt === now) {
		const domain = await findDomain(db, tenantId, after.id);
		if (domain) return { outcome: 'claimed', domain };
	}
	if (after && after.tenantId === tenantId && after.state !== 'disabled') {
		// A concurrent request from the same workspace claimed it first.
		const domain = await findDomain(db, tenantId, after.id);
		if (domain) return { outcome: 'existing', domain };
	}
	const live =
		after !== null &&
		after.tenantId !== tenantId &&
		(after.tenantId === null ||
			after.state === 'active' ||
			(after.state !== 'disabled' && (after.claimExpiresAt ?? 0) > now));
	if (live) return { outcome: 'taken' };
	const usage = await domainUsage(db, tenantId);
	return usage ? { outcome: 'limit_reached' } : { outcome: 'unavailable' };
}

async function findClaim(db: D1Database, hostname: string) {
	const row = await db
		.prepare(
			'SELECT d.id, d.tenant_id, d.state, d.claimed_at, d.claim_expires_at FROM domain_namespaces n JOIN domains d ON d.id = n.id WHERE n.hostname = ?'
		)
		.bind(hostname)
		.first<Record<string, unknown>>();
	if (!row || typeof row.id !== 'string') return null;
	return {
		id: row.id,
		tenantId: typeof row.tenant_id === 'string' ? row.tenant_id : null,
		state: row.state as DomainState,
		claimedAt: optionalInteger(row.claimed_at, 'claim time'),
		claimExpiresAt: optionalInteger(row.claim_expires_at, 'claim expiry')
	};
}

// The only state transition. A removed domain never changes; an active domain stays active
// while the provider is only waiting or verifying (such as a certificate renewal).
export async function applyDomainEvidence(
	db: D1Database,
	change: { domainId: string; claimedAt: number | null; evidence: DomainEvidence; now: number }
): Promise<void> {
	const { domainId, claimedAt, evidence, now } = change;
	// claimed_at guards against evidence for an earlier claim of the same hostname.
	const guard = 'id = ? AND claimed_at IS ? AND tenant_id IS NOT NULL';
	const statement =
		evidence.status === 'ready'
			? db
					.prepare(
						`UPDATE domains SET state = 'active', activated_at = COALESCE(activated_at, ?), claim_expires_at = NULL, failure_code = NULL, updated_at = ? WHERE ${guard} AND state != 'disabled'`
					)
					.bind(now, now, domainId, claimedAt)
			: evidence.status === 'failed'
				? db
						.prepare(
							`UPDATE domains SET state = 'failed', failure_code = ?, updated_at = ? WHERE ${guard} AND state != 'disabled'`
						)
						.bind(evidence.code, now, domainId, claimedAt)
				: db
						.prepare(
							`UPDATE domains SET state = ?, failure_code = NULL, updated_at = ? WHERE ${guard} AND state IN ('pending','verifying','failed')`
						)
						.bind(
							evidence.status === 'waiting' ? 'pending' : 'verifying',
							now,
							domainId,
							claimedAt
						);
	await statement.run();
}

// Spaces out checks that a person asks for. Returns false when the last one was too recent.
export async function markDomainChecked(
	db: D1Database,
	tenantId: string,
	domainId: string,
	now: number,
	intervalMs: number
): Promise<boolean> {
	const row = await db
		.prepare(
			"UPDATE domains SET checked_at = ?1 WHERE id = ?2 AND tenant_id = ?3 AND state != 'disabled' AND (checked_at IS NULL OR checked_at <= ?4) RETURNING id"
		)
		.bind(now, domainId, tenantId, now - intervalMs)
		.first();
	return row !== null;
}

// Links on the domain stop at once; links and slug reservations stay, so a re-add restores them.
export async function disableDomain(
	db: D1Database,
	tenantId: string,
	domainId: string,
	now: number
): Promise<boolean> {
	const row = await db
		.prepare(
			"UPDATE domains SET state = 'disabled', claim_expires_at = NULL, updated_at = ? WHERE id = ? AND tenant_id = ? AND state != 'disabled' RETURNING id"
		)
		.bind(now, domainId, tenantId)
		.first();
	return row !== null;
}

// For the redirect handler: whether the hostname is an active platform or workspace domain.
export async function activeDomainKind(
	db: D1Database,
	hostname: string
): Promise<'platform' | 'workspace' | null> {
	const row = await db
		.prepare(
			"SELECT d.tenant_id FROM domain_namespaces n JOIN domains d ON d.id = n.id WHERE n.hostname = ? AND d.state = 'active'"
		)
		.bind(hostname)
		.first<{ tenant_id: unknown }>();
	if (!row) return null;
	return row.tenant_id === null ? 'platform' : 'workspace';
}
