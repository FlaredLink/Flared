// SPDX-License-Identifier: AGPL-3.0-only
// Reads and deletes API tokens. The auth plugin creates and verifies them; these queries are
// scoped to the owning user and the workspace in the token's server-set metadata.
import type { D1Database } from '@cloudflare/workers-types/index.ts';

export interface StoredApiToken {
	id: string;
	name: string;
	start: string;
	permissions: string | null;
	createdAt: number;
	lastRequest: number | null;
	expiresAt: number | null;
}

function text(value: unknown, field: string): string {
	if (typeof value !== 'string') throw new Error(`Invalid stored token ${field}`);
	return value;
}
function time(value: unknown, field: string): number | null {
	if (value === null) return null;
	if (typeof value !== 'number' || !Number.isFinite(value))
		throw new Error(`Invalid stored token ${field}`);
	return value;
}

const tokenScope = `"referenceId" = ? AND json_extract("metadata", '$.tenantId') = ?`;

// Unexpired tokens, newest first. The trigger in migration 0005 caps a user at 25.
export async function listApiTokens(
	db: D1Database,
	userId: string,
	tenantId: string,
	now: number
): Promise<StoredApiToken[]> {
	const { results } = await db
		.prepare(
			`SELECT "id", "name", "start", "permissions", "createdAt", "lastRequest", "expiresAt" FROM "apikey" WHERE ${tokenScope} AND ("expiresAt" IS NULL OR "expiresAt" > ?) ORDER BY "createdAt" DESC, "id" DESC LIMIT 50`
		)
		.bind(userId, tenantId, now)
		.all<Record<string, unknown>>();
	return results.map((row) => ({
		id: text(row.id, 'id'),
		name: text(row.name, 'name'),
		start: text(row.start, 'start'),
		permissions: row.permissions === null ? null : text(row.permissions, 'permissions'),
		createdAt: time(row.createdAt, 'createdAt') ?? 0,
		lastRequest: time(row.lastRequest, 'lastRequest'),
		expiresAt: time(row.expiresAt, 'expiresAt')
	}));
}

// Returns false when no token with this ID belongs to the user and workspace.
export async function deleteApiToken(
	db: D1Database,
	userId: string,
	tenantId: string,
	id: string
): Promise<boolean> {
	const result = await db
		.prepare(`DELETE FROM "apikey" WHERE "id" = ? AND ${tokenScope}`)
		.bind(id, userId, tenantId)
		.run();
	return result.meta.changes > 0;
}

export async function deleteExpiredApiTokens(
	db: D1Database,
	now: number,
	limit: number
): Promise<number> {
	const result = await db
		.prepare(
			`DELETE FROM "apikey" WHERE "id" IN (SELECT "id" FROM "apikey" WHERE "expiresAt" IS NOT NULL AND "expiresAt" <= ? LIMIT ?)`
		)
		.bind(now, limit)
		.run();
	return result.meta.changes;
}
