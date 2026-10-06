// SPDX-License-Identifier: AGPL-3.0-only
// Analytics-shard records: the policy copy, event receipts, daily aggregates, and monthly usage.
import type { D1Database } from '@cloudflare/workers-types/index.ts';
import type { ExportDailyDimension, ExportDailyTotal } from '@flared/contracts/export';

export interface AnalyticsPolicy {
	tenantId: string;
	revision: number;
	monthlyClickLimit: number;
	retentionDays: number;
	now: number;
}

export interface ShardPolicy {
	monthlyClickLimit: number;
	retentionDays: number;
}

// One production click, already validated, with its UTC day and month.
export interface ClickRecord {
	tenantId: string;
	eventId: string;
	linkId: string;
	day: string;
	month: string;
	country: string;
	device: string;
	referrer: string;
}

// admitted: counted. skipped: the monthly allowance was full. duplicate: an earlier attempt
// owns the event ID. no_policy: the shard holds no policy for the tenant; nothing was written.
export type IngestOutcome = 'admitted' | 'skipped' | 'duplicate' | 'no_policy';

export interface DimensionRow {
	dimension: 'country' | 'device' | 'referrer';
	value: string;
	clicks: number;
}

// A link and day keep at most this many referrer host names; later ones count as "other".
export const referrerLimit = 50;
export const receiptLifetimeMs = 72 * 60 * 60 * 1000;
export const tombstoneLifetimeMs = 90 * 86400000;

function count(value: unknown, field: string): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
		throw new Error(`Invalid stored ${field}`);
	return value;
}

function text(value: unknown, field: string): string {
	if (typeof value !== 'string' || !value) throw new Error(`Invalid stored ${field}`);
	return value;
}

export async function applyAnalyticsPolicy(db: D1Database, policy: AnalyticsPolicy): Promise<void> {
	await db
		.prepare(
			'INSERT INTO tenant_policy (tenant_id, revision, monthly_click_limit, retention_days, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(tenant_id) DO UPDATE SET revision = excluded.revision, monthly_click_limit = excluded.monthly_click_limit, retention_days = excluded.retention_days, updated_at = excluded.updated_at WHERE excluded.revision > tenant_policy.revision'
		)
		.bind(
			policy.tenantId,
			policy.revision,
			policy.monthlyClickLimit,
			policy.retentionDays,
			policy.now
		)
		.run();
}

export async function readShardPolicy(
	db: D1Database,
	tenantId: string
): Promise<ShardPolicy | null> {
	const row = await db
		.prepare('SELECT monthly_click_limit, retention_days FROM tenant_policy WHERE tenant_id = ?')
		.bind(tenantId)
		.first<Record<string, unknown>>();
	if (!row) return null;
	return {
		monthlyClickLimit: count(row.monthly_click_limit, 'click limit'),
		retentionDays: count(row.retention_days, 'retention')
	};
}

// One transactional batch. D1 cannot branch between statements, so every mutation carries its
// own guard: the receipt that this attempt inserted (same token) must be admitted. A new token
// for each attempt means a replay after a committed attempt matches no row and changes nothing;
// a failed batch rolls back the receipt with the counts, so the retry starts clean.
export async function ingestClick(
	db: D1Database,
	click: ClickRecord,
	attemptToken: string,
	now: number
): Promise<IngestOutcome> {
	const { tenantId, eventId, linkId, day, month } = click;
	const admitted =
		"EXISTS (SELECT 1 FROM event_receipts WHERE tenant_id = ? AND event_id = ? AND attempt_token = ? AND outcome = 'admitted')";
	const guard = [tenantId, eventId, attemptToken];
	const dimension = (name: string, value: string) =>
		db
			.prepare(
				`INSERT INTO daily_dimensions (tenant_id, link_id, day, dimension, value, clicks) SELECT ?, ?, ?, ?, ?, 1 WHERE ${admitted} ON CONFLICT(tenant_id, link_id, day, dimension, value) DO UPDATE SET clicks = clicks + 1`
			)
			.bind(tenantId, linkId, day, name, value, ...guard);
	const referrerRow =
		"SELECT 1 FROM daily_dimensions WHERE tenant_id = ? AND link_id = ? AND day = ? AND dimension = 'referrer' AND value = ?";
	const results = await db.batch([
		db
			.prepare(
				"INSERT INTO event_receipts (tenant_id, event_id, attempt_token, outcome, received_at) SELECT ?, ?, ?, 'pending', ? WHERE EXISTS (SELECT 1 FROM tenant_policy WHERE tenant_id = ?) ON CONFLICT(tenant_id, event_id) DO NOTHING"
			)
			.bind(tenantId, eventId, attemptToken, now, tenantId),
		// The allowance is read inside the batch, so concurrent batches cannot both take the
		// last click.
		db
			.prepare(
				"UPDATE event_receipts SET outcome = CASE WHEN COALESCE((SELECT clicks FROM monthly_usage WHERE tenant_id = ? AND month = ?), 0) < (SELECT monthly_click_limit FROM tenant_policy WHERE tenant_id = ?) THEN 'admitted' ELSE 'skipped' END WHERE tenant_id = ? AND event_id = ? AND attempt_token = ? AND outcome = 'pending'"
			)
			.bind(tenantId, month, tenantId, ...guard),
		db
			.prepare(
				`INSERT INTO monthly_usage (tenant_id, month, clicks) SELECT ?, ?, 1 WHERE ${admitted} ON CONFLICT(tenant_id, month) DO UPDATE SET clicks = clicks + 1`
			)
			.bind(tenantId, month, ...guard),
		// A skipped click is counted as missing, so the dashboard can label the gap.
		db
			.prepare(
				"INSERT INTO monthly_usage (tenant_id, month, clicks, skipped_clicks, first_skipped_at) SELECT ?, ?, 0, 1, ? WHERE EXISTS (SELECT 1 FROM event_receipts WHERE tenant_id = ? AND event_id = ? AND attempt_token = ? AND outcome = 'skipped') ON CONFLICT(tenant_id, month) DO UPDATE SET skipped_clicks = skipped_clicks + 1, first_skipped_at = COALESCE(first_skipped_at, excluded.first_skipped_at)"
			)
			.bind(tenantId, month, now, ...guard),
		db
			.prepare(
				`INSERT INTO daily_totals (tenant_id, link_id, day, clicks) SELECT ?, ?, ?, 1 WHERE ${admitted} ON CONFLICT(tenant_id, link_id, day) DO UPDATE SET clicks = clicks + 1`
			)
			.bind(tenantId, linkId, day, ...guard),
		dimension('country', click.country),
		dimension('device', click.device),
		// A known referrer always counts under its name; a new one only while the link and day
		// hold fewer than the limit.
		db
			.prepare(
				`INSERT INTO daily_dimensions (tenant_id, link_id, day, dimension, value, clicks) SELECT ?, ?, ?, 'referrer', ?, 1 WHERE ${admitted} AND (EXISTS (${referrerRow}) OR (SELECT COUNT(*) FROM daily_dimensions WHERE tenant_id = ? AND link_id = ? AND day = ? AND dimension = 'referrer' AND value <> 'other') < ?) ON CONFLICT(tenant_id, link_id, day, dimension, value) DO UPDATE SET clicks = clicks + 1`
			)
			.bind(
				tenantId,
				linkId,
				day,
				click.referrer,
				...guard,
				tenantId,
				linkId,
				day,
				click.referrer,
				tenantId,
				linkId,
				day,
				referrerLimit
			),
		db
			.prepare(
				`INSERT INTO daily_dimensions (tenant_id, link_id, day, dimension, value, clicks) SELECT ?, ?, ?, 'referrer', 'other', 1 WHERE ${admitted} AND NOT EXISTS (${referrerRow}) ON CONFLICT(tenant_id, link_id, day, dimension, value) DO UPDATE SET clicks = clicks + 1`
			)
			.bind(tenantId, linkId, day, ...guard, tenantId, linkId, day, click.referrer),
		db
			.prepare(
				'SELECT (SELECT outcome FROM event_receipts WHERE tenant_id = ? AND event_id = ? AND attempt_token = ?) AS outcome, EXISTS (SELECT 1 FROM event_receipts WHERE tenant_id = ? AND event_id = ?) AS seen'
			)
			.bind(...guard, tenantId, eventId)
	]);
	const row = results.at(-1)?.results[0];
	if (typeof row !== 'object' || row === null) throw new Error('Ingestion returned no outcome');
	const { outcome, seen } = Object.fromEntries(Object.entries(row));
	if (outcome === 'admitted' || outcome === 'skipped') return outcome;
	if (outcome !== null) throw new Error('Invalid stored outcome');
	return seen === 1 ? 'duplicate' : 'no_policy';
}

export async function readDailyTotals(
	db: D1Database,
	tenantId: string,
	linkId: string,
	from: string,
	to: string
): Promise<Map<string, number>> {
	const { results } = await db
		.prepare(
			'SELECT day, clicks FROM daily_totals WHERE tenant_id = ? AND link_id = ? AND day >= ? AND day <= ? ORDER BY day LIMIT 400'
		)
		.bind(tenantId, linkId, from, to)
		.all<Record<string, unknown>>();
	return new Map(results.map((row) => [text(row.day, 'day'), count(row.clicks, 'clicks')]));
}

// Sums each value over the range. Referrers stay bounded: 51 values per day at most.
export async function readDimensions(
	db: D1Database,
	tenantId: string,
	linkId: string,
	from: string,
	to: string
): Promise<DimensionRow[]> {
	const { results } = await db
		.prepare(
			'SELECT dimension, value, SUM(clicks) AS clicks FROM daily_dimensions WHERE tenant_id = ? AND link_id = ? AND day >= ? AND day <= ? GROUP BY dimension, value ORDER BY clicks DESC, value LIMIT 1000'
		)
		.bind(tenantId, linkId, from, to)
		.all<Record<string, unknown>>();
	return results.map((row) => {
		const dimension = row.dimension;
		if (dimension !== 'country' && dimension !== 'device' && dimension !== 'referrer')
			throw new Error('Invalid stored dimension');
		return { dimension, value: text(row.value, 'value'), clicks: count(row.clicks, 'clicks') };
	});
}

// Clicks since a day for each of up to 100 links of one tenant.
export async function readLinkClickTotals(
	db: D1Database,
	tenantId: string,
	linkIds: string[],
	from: string
): Promise<Map<string, number>> {
	if (linkIds.length === 0) return new Map();
	if (linkIds.length > 100) throw new Error('Too many links');
	const { results } = await db
		.prepare(
			`SELECT link_id, SUM(clicks) AS clicks FROM daily_totals WHERE tenant_id = ? AND day >= ? AND link_id IN (${linkIds.map(() => '?').join(', ')}) GROUP BY link_id`
		)
		.bind(tenantId, from, ...linkIds)
		.all<Record<string, unknown>>();
	return new Map(results.map((row) => [text(row.link_id, 'link'), count(row.clicks, 'clicks')]));
}

// One export page of a tenant's daily totals from a day on, in primary key order. after is the
// last row of the previous page.
export async function readExportTotals(
	db: D1Database,
	tenantId: string,
	from: string,
	after: { linkId: string; day: string } | null,
	limit: number
): Promise<ExportDailyTotal[]> {
	const { results } = await db
		.prepare(
			`SELECT link_id, day, clicks FROM daily_totals WHERE tenant_id = ? AND day >= ?${after ? ' AND (link_id, day) > (?, ?)' : ''} ORDER BY link_id, day LIMIT ?`
		)
		.bind(tenantId, from, ...(after ? [after.linkId, after.day] : []), limit)
		.all<Record<string, unknown>>();
	return results.map((row) => ({
		linkId: text(row.link_id, 'link'),
		day: text(row.day, 'day'),
		clicks: count(row.clicks, 'clicks')
	}));
}

// The same for the daily breakdowns.
export async function readExportDimensions(
	db: D1Database,
	tenantId: string,
	from: string,
	after: Omit<ExportDailyDimension, 'clicks'> | null,
	limit: number
): Promise<ExportDailyDimension[]> {
	const { results } = await db
		.prepare(
			`SELECT link_id, day, dimension, value, clicks FROM daily_dimensions WHERE tenant_id = ? AND day >= ?${after ? ' AND (link_id, day, dimension, value) > (?, ?, ?, ?)' : ''} ORDER BY link_id, day, dimension, value LIMIT ?`
		)
		.bind(
			tenantId,
			from,
			...(after ? [after.linkId, after.day, after.dimension, after.value] : []),
			limit
		)
		.all<Record<string, unknown>>();
	return results.map((row) => {
		const dimension = row.dimension;
		if (dimension !== 'country' && dimension !== 'device' && dimension !== 'referrer')
			throw new Error('Invalid stored dimension');
		return {
			linkId: text(row.link_id, 'link'),
			day: text(row.day, 'day'),
			dimension,
			value: text(row.value, 'value'),
			clicks: count(row.clicks, 'clicks')
		};
	});
}

export interface MonthlyUsage {
	clicks: number;
	skippedClicks: number;
	// When the first click of the month was not recorded, in milliseconds.
	firstSkippedAt: number | null;
}

export async function readMonthlyUsage(
	db: D1Database,
	tenantId: string,
	month: string
): Promise<MonthlyUsage> {
	const row = await db
		.prepare(
			'SELECT clicks, skipped_clicks, first_skipped_at FROM monthly_usage WHERE tenant_id = ? AND month = ?'
		)
		.bind(tenantId, month)
		.first<Record<string, unknown>>();
	if (!row) return { clicks: 0, skippedClicks: 0, firstSkippedAt: null };
	return {
		clicks: count(row.clicks, 'clicks'),
		skippedClicks: count(row.skipped_clicks, 'skipped clicks'),
		firstSkippedAt: row.first_skipped_at === null ? null : count(row.first_skipped_at, 'skip time')
	};
}

export interface ClickUsageRow {
	tenantId: string;
	clicks: number;
	monthlyClickLimit: number;
}

// Tenants of this shard at or above 80% of their allowance in a month, in tenant order after
// the cursor. Tenants with no allowance are left out: they have nothing to warn about.
export async function listHighClickUsage(
	db: D1Database,
	month: string,
	after: string,
	limit: number
): Promise<ClickUsageRow[]> {
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
		throw new Error('Invalid usage batch size');
	const { results } = await db
		.prepare(
			'SELECT u.tenant_id, u.clicks, p.monthly_click_limit FROM monthly_usage u JOIN tenant_policy p ON p.tenant_id = u.tenant_id WHERE u.month = ? AND u.tenant_id > ? AND p.monthly_click_limit > 0 AND u.clicks * 5 >= p.monthly_click_limit * 4 ORDER BY u.tenant_id LIMIT ?'
		)
		.bind(month, after, limit)
		.all<Record<string, unknown>>();
	return results.map((row) => ({
		tenantId: text(row.tenant_id, 'tenant'),
		clicks: count(row.clicks, 'clicks'),
		monthlyClickLimit: count(row.monthly_click_limit, 'click limit')
	}));
}

// Removes aggregates older than each tenant's retention and receipts past the replay window.
// Each statement removes at most `limit` rows; the daily job runs it until nothing is left.
export async function purgeExpired(
	db: D1Database,
	now: number,
	limit: number
): Promise<{ deleted: number }> {
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000)
		throw new Error('Invalid purge batch size');
	// The oldest kept day is today minus retention_days - 1, as the readers use.
	const expired = (table: string) =>
		db
			.prepare(
				`DELETE FROM ${table} WHERE rowid IN (SELECT d.rowid FROM ${table} d JOIN tenant_policy p ON p.tenant_id = d.tenant_id WHERE d.day < date(? / 1000, 'unixepoch', '-' || (p.retention_days - 1) || ' days') LIMIT ?)`
			)
			.bind(now, limit);
	const results = await db.batch([
		expired('daily_totals'),
		expired('daily_dimensions'),
		db
			.prepare(
				'DELETE FROM event_receipts WHERE (tenant_id, event_id) IN (SELECT tenant_id, event_id FROM event_receipts WHERE received_at < ? LIMIT ?)'
			)
			.bind(now - receiptLifetimeMs, limit),
		// A deleted tenant's tombstone outlives the replay horizon, then goes.
		db
			.prepare(
				'DELETE FROM tenant_tombstones WHERE tenant_id IN (SELECT tenant_id FROM tenant_tombstones WHERE deleted_at < ? LIMIT ?)'
			)
			.bind(now - tombstoneLifetimeMs, limit)
	]);
	return { deleted: results.reduce((sum, result) => sum + (result.meta.changes ?? 0), 0) };
}
