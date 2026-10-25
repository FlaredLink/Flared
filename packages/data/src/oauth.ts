// SPDX-License-Identifier: AGPL-3.0-only
// Queries on the OAuth authorization server tables that the provider library does not offer:
// access-token checks for the MCP endpoint, the workspaces a grant adds, the connected-apps list,
// revocation, request budgets, and cleanup. Every grant query is scoped to the user and the workspace.
import type { D1Database } from '@cloudflare/workers-types/index.ts';

export interface StoredAccessToken {
	clientId: string;
	userId: string;
	tenantId: string;
	scopes: string[];
	resources: string[];
	expiresAt: number;
	// The grant adds other workspaces to its own (oauth_grant_workspaces).
	addsWorkspaces: boolean;
}

export interface StoredGrant {
	clientId: string;
	name: string | null;
	uri: string | null;
	redirectUris: string[];
	scopes: string[];
	connectedAt: number;
	lastActiveAt: number | null;
	// The operator registered the client. Such clients are linked to the REST API only.
	operator: boolean;
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
			g."scopes" AS "grantScopes",
			EXISTS (SELECT 1 FROM oauth_grant_workspaces w WHERE w.client_id = t."clientId"
				AND w.user_id = t."userId" AND w.grant_tenant_id = t."referenceId") AS "addsWorkspaces"
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
		expiresAt: number(row.expiresAt, 'expiry'),
		addsWorkspaces: row.addsWorkspaces === 1
	};
}

// Apps that can act in the workspace, newest first: grants whose first workspace it is, and grants
// that add it. An app with grants of both kinds is listed once, with the grant made here.
export async function listGrants(
	db: D1Database,
	userId: string,
	tenantId: string
): Promise<StoredGrant[]> {
	const { results } = await db
		.prepare(
			`SELECT g."clientId", c."name", c."uri", c."redirectUris", g."scopes", g."createdAt",
			(SELECT MAX(t."createdAt") FROM "oauthAccessToken" t WHERE t."clientId" = g."clientId"
				AND t."userId" = g."userId" AND t."referenceId" = g."referenceId") AS "lastActiveAt",
			EXISTS (SELECT 1 FROM oauth_operator_clients o WHERE o.client_id = g."clientId") AS "operator"
			FROM "oauthConsent" g JOIN "oauthClient" c ON c."clientId" = g."clientId"
			WHERE g."userId" = ?1 AND (g."referenceId" = ?2 OR EXISTS (SELECT 1 FROM oauth_grant_workspaces w
				WHERE w.client_id = g."clientId" AND w.user_id = g."userId"
				AND w.grant_tenant_id = g."referenceId" AND w.tenant_id = ?2))
			ORDER BY g."referenceId" = ?2 DESC, g."createdAt" DESC, g."id" DESC LIMIT 100`
		)
		.bind(userId, tenantId)
		.all<Record<string, unknown>>();
	const seen = new Set<string>();
	const grants: StoredGrant[] = [];
	for (const row of results) {
		const clientId = text(row.clientId, 'client');
		if (seen.has(clientId)) continue;
		seen.add(clientId);
		grants.push({
			clientId,
			name: typeof row.name === 'string' ? row.name : null,
			uri: typeof row.uri === 'string' ? row.uri : null,
			redirectUris: list(row.redirectUris),
			scopes: list(row.scopes),
			connectedAt: number(row.createdAt, 'consent time'),
			lastActiveAt: row.lastActiveAt === null ? null : number(row.lastActiveAt, 'activity time'),
			operator: row.operator === 1
		});
	}
	return grants.sort((a, b) => b.connectedAt - a.connectedAt);
}

// The workspaces that a grant adds to its first one, oldest first.
export async function listGrantWorkspaces(
	db: D1Database,
	clientId: string,
	userId: string,
	grantTenantId: string
): Promise<string[]> {
	const { results } = await db
		.prepare(
			`SELECT tenant_id FROM oauth_grant_workspaces
			WHERE client_id = ? AND user_id = ? AND grant_tenant_id = ?
			ORDER BY created_at, tenant_id LIMIT 100`
		)
		.bind(clientId, userId, grantTenantId)
		.all<Record<string, unknown>>();
	return results.map((row) => text(row.tenant_id, 'workspace'));
}

// Replaces the workspaces that a grant adds, after the person approves it again.
export async function setGrantWorkspaces(
	db: D1Database,
	grant: { clientId: string; userId: string; grantTenantId: string },
	tenantIds: readonly string[],
	now: number
): Promise<void> {
	const { clientId, userId, grantTenantId } = grant;
	await db.batch([
		db
			.prepare(
				'DELETE FROM oauth_grant_workspaces WHERE client_id = ? AND user_id = ? AND grant_tenant_id = ?'
			)
			.bind(clientId, userId, grantTenantId),
		...tenantIds
			.filter((tenantId) => tenantId !== grantTenantId)
			.map((tenantId) =>
				db
					.prepare(
						`INSERT OR IGNORE INTO oauth_grant_workspaces (client_id, user_id, grant_tenant_id, tenant_id, created_at)
						VALUES (?, ?, ?, ?, ?)`
					)
					.bind(clientId, userId, grantTenantId, tenantId, now)
			)
	]);
}

// Ends the app's access in the workspace at once: a grant made there, with its consent, its
// tokens, and the workspaces it adds, and the workspace's place in grants made elsewhere. Returns
// false when the app could not act in the workspace.
export async function deleteGrant(
	db: D1Database,
	userId: string,
	tenantId: string,
	clientId: string
): Promise<boolean> {
	const scope = '"clientId" = ? AND "userId" = ? AND "referenceId" = ?';
	const [, , consent, , added] = await db.batch([
		db.prepare(`DELETE FROM "oauthAccessToken" WHERE ${scope}`).bind(clientId, userId, tenantId),
		db.prepare(`DELETE FROM "oauthRefreshToken" WHERE ${scope}`).bind(clientId, userId, tenantId),
		db.prepare(`DELETE FROM "oauthConsent" WHERE ${scope}`).bind(clientId, userId, tenantId),
		db
			.prepare(
				'DELETE FROM oauth_grant_workspaces WHERE client_id = ? AND user_id = ? AND grant_tenant_id = ?'
			)
			.bind(clientId, userId, tenantId),
		db
			.prepare(
				'DELETE FROM oauth_grant_workspaces WHERE client_id = ? AND user_id = ? AND tenant_id = ?'
			)
			.bind(clientId, userId, tenantId)
	]);
	return consent.meta.changes > 0 || added.meta.changes > 0;
}

// Ends every app's access for the user, such as before account deletion.
export async function deleteUserGrants(db: D1Database, userId: string): Promise<void> {
	await db.batch([
		db.prepare('DELETE FROM "oauthAccessToken" WHERE "userId" = ?').bind(userId),
		db.prepare('DELETE FROM "oauthRefreshToken" WHERE "userId" = ?').bind(userId),
		db.prepare('DELETE FROM "oauthConsent" WHERE "userId" = ?').bind(userId),
		db.prepare('DELETE FROM oauth_grant_workspaces WHERE user_id = ?').bind(userId)
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

// Counts one REST API call for a grant per minute, in the same table under its own key.
export function countApiCall(
	db: D1Database,
	grantKey: string,
	now: number,
	limit: number
): Promise<WindowCount> {
	return countWindow(db, 'mcp_call_windows', 'grant_key', `v1:${grantKey}`, now, 60_000, limit);
}

export interface OperatorClient {
	clientId: string;
	name: string;
	redirectUris: string[];
	authMethod: string;
	resources: string[];
	disabled: boolean;
	createdAt: number;
}

// Records a just-registered client as the operator's and links it to the given resource only.
export async function claimOperatorClient(
	db: D1Database,
	clientId: string,
	resource: string,
	now: number
): Promise<void> {
	await db.batch([
		db
			.prepare('INSERT INTO oauth_operator_clients (client_id, created_at) VALUES (?, ?)')
			.bind(clientId, now),
		db.prepare('DELETE FROM "oauthClientResource" WHERE "clientId" = ?').bind(clientId),
		db
			.prepare(
				'INSERT INTO "oauthClientResource" ("id", "clientId", "resourceId", "createdAt") VALUES (?, ?, ?, ?)'
			)
			.bind(crypto.randomUUID(), clientId, resource, now)
	]);
}

// The operator's clients, newest first.
export async function listOperatorClients(db: D1Database): Promise<OperatorClient[]> {
	const { results } = await db
		.prepare(
			`SELECT c."clientId", c."name", c."redirectUris", c."tokenEndpointAuthMethod", c."disabled",
			c."createdAt", (SELECT json_group_array(r."resourceId") FROM "oauthClientResource" r
				WHERE r."clientId" = c."clientId") AS "resources"
			FROM "oauthClient" c JOIN oauth_operator_clients o ON o.client_id = c."clientId"
			ORDER BY o.created_at DESC, c."id" DESC LIMIT 100`
		)
		.all<Record<string, unknown>>();
	return results.map((row) => ({
		clientId: text(row.clientId, 'client'),
		name: typeof row.name === 'string' ? row.name : '',
		redirectUris: list(row.redirectUris),
		authMethod: text(row.tokenEndpointAuthMethod, 'auth method'),
		resources: list(row.resources),
		disabled: row.disabled === 1,
		createdAt: number(row.createdAt, 'client time')
	}));
}

// Turns off an operator client: its tokens stop working at once, and it cannot get new ones.
// Returns false when no operator client has the ID.
export async function disableOperatorClient(db: D1Database, clientId: string): Promise<boolean> {
	const result = await db
		.prepare(
			'UPDATE "oauthClient" SET "disabled" = 1 WHERE "clientId" = ? AND "clientId" IN (SELECT client_id FROM oauth_operator_clients)'
		)
		.bind(clientId)
		.run();
	return result.meta.changes > 0;
}

// Removes expired tokens and assertions, request windows older than a day, and clients that
// nobody consented to within a week of registration, except the operator's. Each statement
// deletes at most `limit`.
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
				AND NOT EXISTS (SELECT 1 FROM oauth_operator_clients o WHERE o.client_id = c."clientId")
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
