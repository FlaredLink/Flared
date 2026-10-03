// SPDX-License-Identifier: AGPL-3.0-only
// Routing-store records for domains, permanent slug reservations, links, and create keys.
import type { D1Database } from '@cloudflare/workers-types/index.ts';

export interface DomainRow {
	id: string;
	hostname: string;
}

export interface LinkRow {
	id: string;
	domainId: string;
	hostname: string;
	slug: string;
	destination: string;
	title: string | null;
	active: boolean;
	createdAt: number;
	updatedAt: number;
}

// created: link stored. slug_taken / limit_reached: terminal result stored under the key.
// retry: a generated slug collided; nothing stored. unavailable: domain or policy missing;
// nothing stored. duplicate_key: the key already has a record; read it.
export type CreateOutcome =
	'created' | 'slug_taken' | 'limit_reached' | 'retry' | 'unavailable' | 'duplicate_key';

export interface NewLinkRecord {
	tenantId: string;
	key: string;
	requestHash: string;
	linkId: string;
	domainId: string;
	slug: string;
	// A generated slug that collides is retried with a new slug instead of being stored.
	generatedSlug: boolean;
	destination: string;
	title: string | null;
	now: number;
	expiresAt: number;
	bodies: { created: string; slugTaken: string; limitReached: string };
}

export interface StoredResult {
	requestHash: string;
	status: number;
	body: string;
}

export interface LinkChange {
	destination?: string;
	title?: string | null;
	active?: boolean;
	now: number;
}

const linkColumns =
	'l.id, l.domain_id, n.hostname, l.slug, l.destination, l.title, l.status, l.created_at, l.updated_at';

function text(value: unknown, field: string): string {
	if (typeof value !== 'string' || !value) throw new Error(`Invalid stored ${field}`);
	return value;
}

function time(value: unknown, field: string): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value))
		throw new Error(`Invalid stored ${field}`);
	return value;
}

function toLink(row: Record<string, unknown>): LinkRow {
	if (row.status !== 'active' && row.status !== 'disabled') throw new Error('Invalid link status');
	if (row.title !== null && typeof row.title !== 'string') throw new Error('Invalid link title');
	return {
		id: text(row.id, 'link'),
		domainId: text(row.domain_id, 'domain'),
		hostname: text(row.hostname, 'hostname'),
		slug: text(row.slug, 'slug'),
		destination: text(row.destination, 'destination'),
		title: row.title,
		active: row.status === 'active',
		createdAt: time(row.created_at, 'creation time'),
		updatedAt: time(row.updated_at, 'update time')
	};
}

// An explicit domain must be active and owned by the tenant or shared with every tenant.
// Without one, only the installation default qualifies.
export async function findUsableDomain(
	db: D1Database,
	tenantId: string,
	domainId: string | null
): Promise<DomainRow | null> {
	const statement =
		domainId === null
			? db.prepare(
					"SELECT d.id, n.hostname FROM domains d JOIN domain_namespaces n ON n.id = d.id WHERE d.is_default = 1 AND d.state = 'active' AND d.tenant_id IS NULL"
				)
			: db
					.prepare(
						"SELECT d.id, n.hostname FROM domains d JOIN domain_namespaces n ON n.id = d.id WHERE d.id = ? AND d.state = 'active' AND (d.tenant_id IS NULL OR d.tenant_id = ?)"
					)
					.bind(domainId, tenantId);
	const row = await statement.first<Record<string, unknown>>();
	return row ? { id: text(row.id, 'domain'), hostname: text(row.hostname, 'hostname') } : null;
}

// Counts the attempt in a fixed one-minute window and reports whether it fits the limit.
export async function countCreationAttempt(
	db: D1Database,
	tenantId: string,
	now: number,
	limit: number
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
	const windowStart = now - (now % 60000);
	const row = await db
		.prepare(
			'INSERT INTO creation_windows (tenant_id, window_start, count) VALUES (?, ?, 1) ON CONFLICT(tenant_id, window_start) DO UPDATE SET count = count + 1 RETURNING count'
		)
		.bind(tenantId, windowStart)
		.first<{ count: unknown }>();
	const count = typeof row?.count === 'number' ? row.count : Number.POSITIVE_INFINITY;
	return {
		allowed: count <= limit,
		retryAfterSeconds: Math.max(1, Math.ceil((windowStart + 60000 - now) / 1000))
	};
}

export async function readStoredResult(
	db: D1Database,
	tenantId: string,
	key: string,
	now: number
): Promise<StoredResult | null> {
	const row = await db
		.prepare(
			'SELECT request_hash, status, body FROM idempotency_records WHERE tenant_id = ? AND key = ? AND expires_at > ? AND status IS NOT NULL'
		)
		.bind(tenantId, key, now)
		.first<Record<string, unknown>>();
	if (!row) return null;
	return {
		requestHash: text(row.request_hash, 'request hash'),
		status: time(row.status, 'status'),
		body: text(row.body, 'body')
	};
}

// One batch claims the key, decides the outcome with SQL conditions, and writes the
// reservation, link, and stored response together. Expected rejections never raise an
// error, so their stored result is not rolled back; the reservation key stays the final guard.
export async function createLinkRecord(
	db: D1Database,
	record: NewLinkRecord
): Promise<CreateOutcome> {
	const { tenantId: t, key: k } = record;
	const outcomeOf = 'SELECT outcome FROM idempotency_records WHERE tenant_id = ?1 AND key = ?2';
	try {
		const results = await db.batch([
			db
				.prepare(
					'DELETE FROM idempotency_records WHERE tenant_id = ? AND key = ? AND expires_at <= ?'
				)
				.bind(t, k, record.now),
			db
				.prepare(
					"INSERT INTO idempotency_records (tenant_id, key, request_hash, outcome, created_at, expires_at) VALUES (?, ?, ?, 'pending', ?, ?)"
				)
				.bind(t, k, record.requestHash, record.now, record.expiresAt),
			db
				.prepare(
					`UPDATE idempotency_records SET outcome = CASE
						WHEN NOT EXISTS (SELECT 1 FROM tenant_policy WHERE tenant_id = ?1) THEN 'unavailable'
						WHEN NOT EXISTS (SELECT 1 FROM domains WHERE id = ?3 AND state = 'active' AND (tenant_id IS NULL OR tenant_id = ?1)) THEN 'unavailable'
						WHEN (SELECT COUNT(*) FROM links WHERE tenant_id = ?1 AND status = 'active') >= (SELECT active_link_limit FROM tenant_policy WHERE tenant_id = ?1) THEN 'limit_reached'
						WHEN EXISTS (SELECT 1 FROM slug_reservations WHERE domain_id = ?3 AND slug = ?4) THEN ?5
						ELSE 'created' END
					WHERE tenant_id = ?1 AND key = ?2`
				)
				.bind(t, k, record.domainId, record.slug, record.generatedSlug ? 'retry' : 'slug_taken'),
			db
				.prepare(
					`INSERT INTO slug_reservations (domain_id, slug) SELECT ?3, ?4 WHERE (${outcomeOf}) = 'created'`
				)
				.bind(t, k, record.domainId, record.slug),
			db
				.prepare(
					`INSERT INTO links (id, tenant_id, domain_id, slug, destination, title, status, created_at, updated_at)
					SELECT ?3, ?1, ?4, ?5, ?6, ?7, 'active', ?8, ?8 WHERE (${outcomeOf}) = 'created'`
				)
				.bind(
					t,
					k,
					record.linkId,
					record.domainId,
					record.slug,
					record.destination,
					record.title,
					record.now
				),
			db
				.prepare(
					`UPDATE idempotency_records SET
						status = CASE outcome WHEN 'created' THEN 201 WHEN 'slug_taken' THEN 409 WHEN 'limit_reached' THEN 403 END,
						body = CASE outcome WHEN 'created' THEN ?3 WHEN 'slug_taken' THEN ?4 WHEN 'limit_reached' THEN ?5 END
					WHERE tenant_id = ?1 AND key = ?2`
				)
				.bind(t, k, record.bodies.created, record.bodies.slugTaken, record.bodies.limitReached),
			db.prepare(outcomeOf).bind(t, k),
			db
				.prepare(
					"DELETE FROM idempotency_records WHERE tenant_id = ? AND key = ? AND outcome IN ('retry', 'unavailable')"
				)
				.bind(t, k)
		]);
		const outcome = (results[6].results[0] as { outcome?: unknown } | undefined)?.outcome;
		if (
			outcome !== 'created' &&
			outcome !== 'slug_taken' &&
			outcome !== 'limit_reached' &&
			outcome !== 'retry' &&
			outcome !== 'unavailable'
		)
			throw new Error('Link creation returned no outcome');
		return outcome;
	} catch (error) {
		// The key's insert failed: an earlier or concurrent request already holds it.
		if (await keyExists(db, t, k, record.now)) return 'duplicate_key';
		throw error;
	}
}

async function keyExists(db: D1Database, tenantId: string, key: string, now: number) {
	const row = await db
		.prepare(
			'SELECT 1 AS found FROM idempotency_records WHERE tenant_id = ? AND key = ? AND expires_at > ?'
		)
		.bind(tenantId, key, now)
		.first();
	return row !== null;
}

export async function readLink(
	db: D1Database,
	tenantId: string,
	linkId: string
): Promise<LinkRow | null> {
	const row = await db
		.prepare(
			`SELECT ${linkColumns} FROM links l JOIN domain_namespaces n ON n.id = l.domain_id WHERE l.tenant_id = ? AND l.id = ?`
		)
		.bind(tenantId, linkId)
		.first<Record<string, unknown>>();
	return row ? toLink(row) : null;
}

function escapeLike(value: string): string {
	return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

// Newest first. The cursor is the last row's (created_at, id), so pages stay stable while
// links are added.
export async function listLinks(
	db: D1Database,
	tenantId: string,
	options: { limit: number; after: { createdAt: number; id: string } | null; search: string | null }
): Promise<LinkRow[]> {
	const conditions = ['l.tenant_id = ?'];
	const values: (string | number)[] = [tenantId];
	if (options.after) {
		conditions.push('(l.created_at < ? OR (l.created_at = ? AND l.id < ?))');
		values.push(options.after.createdAt, options.after.createdAt, options.after.id);
	}
	if (options.search) {
		const pattern = `%${escapeLike(options.search)}%`;
		conditions.push("(l.slug LIKE ? ESCAPE '\\' OR l.title LIKE ? ESCAPE '\\')");
		values.push(pattern, pattern);
	}
	const { results } = await db
		.prepare(
			`SELECT ${linkColumns} FROM links l JOIN domain_namespaces n ON n.id = l.domain_id WHERE ${conditions.join(' AND ')} ORDER BY l.created_at DESC, l.id DESC LIMIT ?`
		)
		.bind(...values, options.limit)
		.all<Record<string, unknown>>();
	return results.map(toLink);
}

// One statement, so reactivation and the active-link count cannot race. Returns false when
// the link is missing or reactivation would exceed the limit; the caller tells them apart.
export async function updateLink(
	db: D1Database,
	tenantId: string,
	linkId: string,
	change: LinkChange
): Promise<boolean> {
	const status = change.active === undefined ? null : change.active ? 'active' : 'disabled';
	const result = await db
		.prepare(
			`UPDATE links SET
				destination = COALESCE(?3, destination),
				title = CASE WHEN ?4 = 1 THEN ?5 ELSE title END,
				status = COALESCE(?6, status),
				updated_at = ?7
			WHERE tenant_id = ?1 AND id = ?2 AND NOT (
				status = 'disabled' AND ?6 = 'active' AND
				(SELECT COUNT(*) FROM links WHERE tenant_id = ?1 AND status = 'active') >=
				COALESCE((SELECT active_link_limit FROM tenant_policy WHERE tenant_id = ?1), 0)
			)`
		)
		.bind(
			tenantId,
			linkId,
			change.destination ?? null,
			change.title === undefined ? 0 : 1,
			change.title ?? null,
			status,
			change.now
		)
		.run();
	return result.meta.changes === 1;
}

export async function deleteExpiredCreationRecords(
	db: D1Database,
	now: number,
	limit: number
): Promise<void> {
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
		throw new Error('Invalid cleanup batch size');
	await db.batch([
		db
			.prepare(
				'DELETE FROM idempotency_records WHERE rowid IN (SELECT rowid FROM idempotency_records WHERE expires_at <= ? ORDER BY expires_at LIMIT ?)'
			)
			.bind(now, limit),
		db
			.prepare(
				'DELETE FROM creation_windows WHERE rowid IN (SELECT rowid FROM creation_windows WHERE window_start < ? ORDER BY window_start LIMIT ?)'
			)
			.bind(now - 3600000, limit)
	]);
}

export interface RedirectTarget {
	tenantId: string;
	linkId: string;
	analyticsShardId: string;
	destination: string;
}

// Redirects read the primary so a committed edit or disable is never hidden by replica lag.
// A link resolves only on an active domain its tenant may use and while the tenant's policy
// exists in routing.
export async function findRedirectTarget(
	db: D1Database,
	hostname: string,
	slug: string
): Promise<RedirectTarget | null> {
	const row = await db
		.withSession('first-primary')
		.prepare(
			`SELECT l.tenant_id, l.id, p.analytics_shard_id, l.destination FROM domain_namespaces n
			JOIN domains d ON d.id = n.id AND d.state = 'active'
			JOIN links l ON l.domain_id = n.id AND l.slug = ? AND l.status = 'active'
			JOIN tenant_policy p ON p.tenant_id = l.tenant_id
			WHERE n.hostname = ? AND (d.tenant_id IS NULL OR d.tenant_id = l.tenant_id)`
		)
		.bind(slug, hostname)
		.first<Record<string, unknown>>();
	if (!row) return null;
	return {
		tenantId: text(row.tenant_id, 'tenant'),
		linkId: text(row.id, 'link'),
		analyticsShardId: text(row.analytics_shard_id, 'shard'),
		destination: text(row.destination, 'destination')
	};
}
