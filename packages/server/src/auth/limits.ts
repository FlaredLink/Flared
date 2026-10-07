// SPDX-License-Identifier: AGPL-3.0-only
// Request budgets of the shared authentication routes. Each edition names the table that holds
// its attempts; the table has the columns id, source_key, created_at, and utc_day.
const hour = 3600000;
const day = 86400000;

// A table name goes into SQL text, so only a plain lowercase identifier is accepted. Budgets
// and the job ledger take their table from the edition.
export function checkedTableName(name: string): string {
	if (!/^[a-z][a-z0-9_]{0,62}$/.test(name)) throw new Error('Invalid table name');
	return name;
}

export async function keyedHash(secret: string, value: string): Promise<string> {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
	return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join(
		''
	);
}

export interface PasskeyLimits {
	sourceHourly: number;
	daily: number;
}
const passkeyDefaults: PasskeyLimits = { sourceHourly: 30, daily: 5000 };

// Counts one passkey sign-in challenge. One conditional write keeps parallel requests within
// both limits; a denied request stores nothing.
export async function consumePasskeyBudget(
	db: D1Database,
	table: string,
	secret: string,
	source: string,
	now: number,
	limits: PasskeyLimits = passkeyDefaults
): Promise<{ allowed: boolean; retryAfter: number }> {
	const attempts = checkedTableName(table);
	if (
		!Number.isSafeInteger(now) ||
		Object.values(limits).some((value) => !Number.isSafeInteger(value) || value < 1)
	)
		throw new Error('Invalid passkey budget configuration');
	const sourceKey = await keyedHash(secret, `passkey-source:${source}`);
	const utcDay = Math.floor(now / day);
	const cutoff = now - hour;
	const reserved = await db
		.prepare(
			`INSERT INTO ${attempts} (id,source_key,created_at,utc_day)
 SELECT ?,?,?,? WHERE
 (SELECT COUNT(*) FROM ${attempts} WHERE source_key=? AND created_at>?)<?
 AND (SELECT COUNT(*) FROM ${attempts} WHERE utc_day=?)<? RETURNING id`
		)
		.bind(
			crypto.randomUUID(),
			sourceKey,
			now,
			utcDay,
			sourceKey,
			cutoff,
			limits.sourceHourly,
			utcDay,
			limits.daily
		)
		.first<{ id: string }>();
	if (reserved) return { allowed: true, retryAfter: 0 };
	const counts = await db
		.prepare(
			`SELECT
 (SELECT COUNT(*) FROM ${attempts} WHERE source_key=? AND created_at>?) AS source_count,
 (SELECT MIN(created_at) FROM ${attempts} WHERE source_key=? AND created_at>?) AS first_source,
 (SELECT COUNT(*) FROM ${attempts} WHERE utc_day=?) AS day_count`
		)
		.bind(sourceKey, cutoff, sourceKey, cutoff, utcDay)
		.first<{ source_count: number; first_source: number | null; day_count: number }>();
	if (!counts) throw new Error('Passkey budget unavailable');
	let release = now;
	if (counts.source_count >= limits.sourceHourly && counts.first_source !== null)
		release = Math.max(release, counts.first_source + hour);
	if (counts.day_count >= limits.daily) release = Math.max(release, (utcDay + 1) * day);
	return { allowed: false, retryAfter: Math.max(1, Math.ceil((release - now) / 1000)) };
}
