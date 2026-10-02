// SPDX-License-Identifier: AGPL-3.0-only
// API tokens for the CLI, the MCP server, and integrations. The Better Auth API-key plugin
// generates, hashes, expires, and rate-limits them. Each token is bound to one workspace
// through metadata that only these server functions set; its HTTP endpoints stay unexposed.
import type { D1Database } from '@cloudflare/workers-types/index.ts';
import { apiKey } from '@better-auth/api-key';
import {
	isTokenScope,
	maxTokenNameLength,
	tokenPrefix,
	tokenScopes,
	type ApiTokenIdentity,
	type ApiTokenSummary,
	type CreateTokenInput,
	type CreatedApiToken,
	type TokenScope
} from '@flared/contracts/tokens';
import { deleteApiToken, listApiTokens, type StoredApiToken } from '@flared/data/tokens';
import { resolveTenant } from '../tenancy';

export const tokenRequestsPerMinute = 60;

export function createApiTokenPlugin() {
	return apiKey({
		defaultPrefix: tokenPrefix,
		enableMetadata: true,
		maximumNameLength: maxTokenNameLength,
		startingCharactersConfig: { shouldStore: true, charactersLength: tokenPrefix.length + 4 },
		rateLimit: { enabled: true, timeWindow: 60_000, maxRequests: tokenRequestsPerMinute },
		keyExpiration: { defaultExpiresIn: null, minExpiresIn: 1, maxExpiresIn: 365 }
	});
}

// The two server-only plugin calls these functions use, typed loosely so that results are
// validated here rather than trusted.
export interface ApiTokenAuth {
	api: {
		createApiKey(input: { body: Record<string, unknown> }): Promise<unknown>;
		verifyApiKey(input: { body: { key: string } }): Promise<unknown>;
	};
}

export interface TokenPrincipal {
	userId: string;
	tenantId: string;
	scopes: TokenScope[];
	token: ApiTokenIdentity;
}

export type TokenVerification =
	| { status: 'valid'; principal: TokenPrincipal }
	| { status: 'invalid' }
	| { status: 'rate_limited'; retryAfterSeconds: number };

export class TokenLimitError extends Error {
	constructor() {
		super('Token limit reached');
	}
}

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

// The plugin stores permissions as {"links":["read","write"]}; scopes are "links:read".
function toPermissions(scopes: TokenScope[]): Record<string, string[]> {
	const permissions: Record<string, string[]> = {};
	for (const scope of scopes) {
		const [resource, action] = scope.split(':');
		(permissions[resource] ??= []).push(action);
	}
	return permissions;
}
function toScopes(permissions: unknown): TokenScope[] {
	const map = record(typeof permissions === 'string' ? safeParse(permissions) : permissions);
	if (!map) return [];
	return tokenScopes.filter((scope) => {
		const [resource, action] = scope.split(':');
		const actions = map[resource];
		return Array.isArray(actions) && actions.includes(action);
	});
}
function safeParse(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		return null;
	}
}
function isoOrNull(value: number | null): string | null {
	return value === null ? null : new Date(value).toISOString();
}
function timeOf(value: unknown): number | null {
	if (value instanceof Date) return value.getTime();
	if (typeof value === 'string' || typeof value === 'number') {
		const time = new Date(value).getTime();
		return Number.isFinite(time) ? time : null;
	}
	return null;
}

function summary(token: StoredApiToken): ApiTokenSummary {
	return {
		id: token.id,
		name: token.name,
		start: token.start,
		scopes: toScopes(token.permissions),
		createdAt: new Date(token.createdAt).toISOString(),
		lastUsedAt: isoOrNull(token.lastRequest),
		expiresAt: isoOrNull(token.expiresAt)
	};
}

export async function createToken(
	auth: ApiTokenAuth,
	request: { userId: string; tenantId: string; input: CreateTokenInput }
): Promise<CreatedApiToken> {
	const { userId, tenantId, input } = request;
	let result: unknown;
	try {
		result = await auth.api.createApiKey({
			body: {
				userId,
				name: input.name,
				permissions: toPermissions(input.scopes),
				metadata: { tenantId },
				...(input.expiresInDays === null ? {} : { expiresIn: input.expiresInDays * 86_400 })
			}
		});
	} catch (error) {
		// The insert trigger in identity migration 0005 enforces the per-user limit.
		if (error instanceof Error && /api_key_limit/.test(`${error.message} ${String(error.cause)}`))
			throw new TokenLimitError();
		throw error;
	}
	const created = record(result);
	const createdAt = timeOf(created?.createdAt);
	if (
		!created ||
		typeof created.id !== 'string' ||
		typeof created.key !== 'string' ||
		!created.key.startsWith(tokenPrefix) ||
		typeof created.start !== 'string' ||
		createdAt === null
	)
		throw new Error('Token creation returned an unexpected result');
	return {
		secret: created.key,
		token: {
			id: created.id,
			name: input.name,
			start: created.start,
			scopes: input.scopes,
			createdAt: new Date(createdAt).toISOString(),
			lastUsedAt: null,
			expiresAt: isoOrNull(timeOf(created.expiresAt))
		}
	};
}

export async function listTokens(
	identity: D1Database,
	userId: string,
	tenantId: string,
	now: number
): Promise<ApiTokenSummary[]> {
	return (await listApiTokens(identity, userId, tenantId, now)).map(summary);
}

// Returns false when the token does not exist or belongs to someone else.
export function revokeToken(
	identity: D1Database,
	userId: string,
	tenantId: string,
	id: string
): Promise<boolean> {
	return deleteApiToken(identity, userId, tenantId, id);
}

// The workspace comes from the token's metadata, and the user must still belong to it.
export async function verifyToken(
	auth: ApiTokenAuth,
	identity: D1Database,
	key: string
): Promise<TokenVerification> {
	if (!key.startsWith(tokenPrefix) || key.length > 128) return { status: 'invalid' };
	const result = record(await auth.api.verifyApiKey({ body: { key } }));
	if (!result) throw new Error('Token verification returned an unexpected result');
	if (result.valid !== true) {
		const error = record(result.error);
		if (error?.code === 'RATE_LIMITED') {
			const tryAgainIn = record(error.details)?.tryAgainIn;
			const seconds =
				typeof tryAgainIn === 'number' && tryAgainIn > 0 ? Math.ceil(tryAgainIn / 1000) : 60;
			return { status: 'rate_limited', retryAfterSeconds: Math.min(seconds, 60) };
		}
		return { status: 'invalid' };
	}
	const stored = record(result.key);
	const userId = stored?.referenceId;
	const tenantId = record(stored?.metadata)?.tenantId;
	const id = stored?.id;
	const start = stored?.start;
	if (
		typeof userId !== 'string' ||
		typeof tenantId !== 'string' ||
		typeof id !== 'string' ||
		typeof start !== 'string'
	)
		return { status: 'invalid' };
	const token: ApiTokenIdentity = {
		id,
		name: typeof stored?.name === 'string' ? stored.name : '',
		start,
		expiresAt: isoOrNull(timeOf(stored?.expiresAt))
	};
	const tenant = await resolveTenant(identity, userId);
	if (tenant.status !== 'active' || tenant.tenantId !== tenantId) return { status: 'invalid' };
	const scopes = toScopes(stored?.permissions).filter(isTokenScope);
	return { status: 'valid', principal: { userId, tenantId, scopes, token } };
}
