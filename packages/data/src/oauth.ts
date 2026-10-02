// SPDX-License-Identifier: AGPL-3.0-only
// Queries on the OAuth authorization server tables that the provider library does not offer:
// access-token checks for the MCP endpoint, the connected-apps list, revocation, request
// budgets, and cleanup. Every grant query is scoped to the user and the workspace.
import type { D1Database } from '@cloudflare/workers-types/index.ts';

export interface StoredAccessToken {
	clientId: string;
	userId: string;
	tenantId: string;
	scopes: string[];
	resources: string[];
	expiresAt: number;
}

export interface StoredGrant {
	clientId: string;
	name: string | null;
	uri: string | null;
	scopes: string[];
	connectedAt: number;
	lastActiveAt: number | null;
}

function text(value: unknown, field: string): string {
	if (typeof value !== 'string') throw new Error(`Invalid stored OAuth ${field}`);
	return value;
}
function number(value: unknown, field: string): number {
	if (typeof value !== 'number' || !Number.isFinite(value))
		throw new Error(`Invalid stored OAuth ${field}`);
	return value;
}
function list(value: unknown): string[] {
	if (typeof value !== 'string') return [];
	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
	} catch {
		return [];
	}
}

// One read: an unexpired, unrevoked token of an enabled client whose consent still stands.
// Revoking a grant deletes the consent, so a token that a concurrent refresh created during the
// revocation stays unusable, and a later consent does not revive it. The token's scopes are cut
// to the consent's. Tokens with a sender constraint are refused: the MCP endpoint checks no DPoP.
export async function findAccessToken(
	db: D1Database,
	tokenHash: string,
	now: number
): Promise<StoredAccessToken | null> {
	const row = await db
		.prepare(
			`SELECT t."clientId", t."userId", t."referenceId", t."scopes", t."resources", t."expiresAt",
			g."scopes" AS "grantScopes"
			FROM "oauthAccessToken" t
			JOIN "oauthClient" c ON c."clientId" = t."clientId"
			JOIN "oauthConsent" g ON g."clientId" = t."clientId" AND g."userId" = t."userId"
				AND g."referenceId" = t."referenceId"
			WHERE t."token" = ? AND t."revoked" IS NULL AND t."expiresAt" > ? AND t."confirmation" IS NULL
			AND t."createdAt" >= g."createdAt" AND COALESCE(c."disabled", 0) = 0`
		)
		.bind(tokenHash, now)
		.first<Record<string, unknown>>();
	if (!row) return null;
	const granted = new Set(list(row.grantScopes));
	return {
		clientId: text(row.clientId, 'client'),
		userId: text(row.userId, 'user'),
		tenantId: text(row.referenceId, 'workspace'),
		scopes: list(row.scopes).filter((scope) => granted.has(scope)),
		resources: list(row.resources),
		expiresAt: number(row.expiresAt, 'expiry')
	};
}

// Apps with a consent in the workspace, newest first.
export async function listGrants(
	db: D1Database,
	userId: string,
	tenantId: string
): Promise<StoredGrant[]> {
	const { results } = await db
		.prepare(
			`SELECT g."clientId", c."name", c."uri", g."scopes", g."createdAt",
			(SELECT MAX(t."createdAt") FROM "oauthAccessToken" t WHERE t."clientId" = g."clientId"
				AND t."userId" = g."userId" AND t."referenceId" = g."referenceId") AS "lastActiveAt"
			FROM "oauthConsent" g JOIN "oauthClient" c ON c."clientId" = g."clientId"
			WHERE g."userId" = ? AND g."referenceId" = ?
			ORDER BY g."createdAt" DESC, g."id" DESC LIMIT 100`
		)
		.bind(userId, tenantId)
		.all<Record<string, unknown>>();
	return results.map((row) => ({
		clientId: text(row.clientId, 'client'),
		name: typeof row.name === 'string' ? row.name : null,
		uri: typeof row.uri === 'string' ? row.uri : null,
		scopes: list(row.scopes),
		connectedAt: number(row.createdAt, 'consent time'),
		lastActiveAt: row.lastActiveAt === null ? null : number(row.lastActiveAt, 'activity time')
	}));
}

// Ends the app's access in the workspace at once: its consent and every access and refresh
// token. Returns false when the user had no consent for the app there.
export async function deleteGrant(
	db: D1Database,
	userId: string,
	tenantId: string,
	clientId: string
): Promise<boolean> {
	const scope = '"clientId" = ? AND "userId" = ? AND "referenceId" = ?';
	const [, , consent] = await db.batch([
		db.prepare(`DELETE FROM "oauthAccessToken" WHERE ${scope}`).bind(clientId, userId, tenantId),
		db.prepare(`DELETE FROM "oauthRefreshToken" WHERE ${scope}`).bind(clientId, userId, tenantId),
		db.prepare(`DELETE FROM "oauthConsent" WHERE ${scope}`).bind(clientId, userId, tenantId)
	]);
	return consent.meta.changes > 0;
}

// Ends every app's access for the user, such as before account deletion.
export async function deleteUserGrants(db: D1Database, userId: string): Promise<void> {
	await db.batch([
		db.prepare('DELETE FROM "oauthAccessToken" WHERE "userId" = ?').bind(userId),
		db.prepare('DELETE FROM "oauthRefreshToken" WHERE "userId" = ?').bind(userId),
		db.prepare('DELETE FROM "oauthConsent" WHERE "userId" = ?').bind(userId)
	]);
}

export interface WindowCount {
	allowed: boolean;
	retryAfterSeconds: number;
}

async function countWindow(
	db: D1Database,
	table: 'oauth_registration_windows' | 'mcp_call_windows',
	keyColumn: 'source_key' | 'grant_key',
	key: string,
	now: number,
	windowMs: number,
	limit: number
): Promise<WindowCount> {
	const windowStart = now - (now % windowMs);
	const row = await db
		.prepare(
			`INSERT INTO ${table} (${keyColumn}, window_start, count) VALUES (?, ?, 1)
			ON CONFLICT(${keyColumn}, window_start) DO UPDATE SET count = count + 1 RETURNING count`
		)
		.bind(key, windowStart)
		.first<{ count: unknown }>();
	const count = typeof row?.count === 'number' ? row.count : Number.POSITIVE_INFINITY;
	return {
		allowed: count <= limit,
		retryAfterSeconds: Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000))
	};
}

// Counts one open client registration for a source per hour.
export function countRegistration(
	db: D1Database,
	sourceKey: string,
	now: number,
	limit: number
): Promise<WindowCount> {
	return countWindow(
		db,
		'oauth_registration_windows',
		'source_key',
		sourceKey,
		now,
		3_600_000,
		limit
	);
}

// Counts one MCP call for a grant per minute.
export function countMcpCall(
	db: D1Database,
	grantKey: string,
	now: number,
	limit: number
): Promise<WindowCount> {
	return countWindow(db, 'mcp_call_windows', 'grant_key', grantKey, now, 60_000, limit);
}

// Removes expired tokens and assertions, request windows older than a day, and clients that
// nobody consented to within a week of registration. Each statement deletes at most `limit`.
export async function deleteExpiredOAuthRecords(
	db: D1Database,
	now: number,
	limit: number
): Promise<void> {
	await db.batch([
		db
			.prepare(
				'DELETE FROM "oauthAccessToken" WHERE "id" IN (SELECT "id" FROM "oauthAccessToken" WHERE "expiresAt" <= ? LIMIT ?)'
			)
			.bind(now, limit),
		db
			.prepare(
				'DELETE FROM "oauthRefreshToken" WHERE "id" IN (SELECT "id" FROM "oauthRefreshToken" WHERE "expiresAt" <= ? LIMIT ?)'
			)
			.bind(now, limit),
		db
			.prepare(
				'DELETE FROM "oauthClientAssertion" WHERE "id" IN (SELECT "id" FROM "oauthClientAssertion" WHERE "expiresAt" <= ? LIMIT ?)'
			)
			.bind(now, limit),
		db
			.prepare(
				`DELETE FROM "oauthClient" WHERE "id" IN (SELECT c."id" FROM "oauthClient" c
				WHERE c."createdAt" <= ?
				AND NOT EXISTS (SELECT 1 FROM "oauthConsent" g WHERE g."clientId" = c."clientId")
				AND NOT EXISTS (SELECT 1 FROM "oauthRefreshToken" r WHERE r."clientId" = c."clientId")
				AND NOT EXISTS (SELECT 1 FROM "oauthAccessToken" t WHERE t."clientId" = c."clientId")
				LIMIT ?)`
			)
			.bind(now - 7 * 86_400_000, limit),
		db
			.prepare(
				'DELETE FROM oauth_registration_windows WHERE rowid IN (SELECT rowid FROM oauth_registration_windows WHERE window_start <= ? LIMIT ?)'
			)
			.bind(now - 86_400_000, limit),
		db
			.prepare(
				'DELETE FROM mcp_call_windows WHERE rowid IN (SELECT rowid FROM mcp_call_windows WHERE window_start <= ? LIMIT ?)'
			)
			.bind(now - 86_400_000, limit)
	]);
}
