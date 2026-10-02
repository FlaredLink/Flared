// SPDX-License-Identifier: AGPL-3.0-only
// API tokens: scopes, the create input, and what the dashboard may show about a token.
import { LinkInputError } from './links';

export const tokenScopes = [
	'links:read',
	'links:write',
	'analytics:read',
	'domains:read',
	'usage:read'
] as const;
export type TokenScope = (typeof tokenScopes)[number];

export const scopePresets = {
	full: [...tokenScopes],
	read: tokenScopes.filter((scope) => scope !== 'links:write')
} satisfies Record<string, TokenScope[]>;

// Lifetimes in days; null means the token does not expire.
export const tokenExpiryDays = [30, 90, 365, null] as const;
export type TokenExpiryDays = (typeof tokenExpiryDays)[number];
export const defaultTokenExpiryDays: TokenExpiryDays = 90;

export const tokenPrefix = 'flr_';
export const maxTokenNameLength = 64;
export const maxTokensPerUser = 25;

export interface CreateTokenInput {
	name: string;
	scopes: TokenScope[];
	expiresInDays: TokenExpiryDays;
}

// What a list may show. The secret is never stored, so no list can carry it.
export interface ApiTokenSummary {
	id: string;
	name: string;
	// The prefix and first characters, such as "flr_ab12".
	start: string;
	scopes: TokenScope[];
	createdAt: string;
	lastUsedAt: string | null;
	expiresAt: string | null;
}

export interface ApiTokenPage {
	tokens: ApiTokenSummary[];
	// Creating a token needs a sign-in before this time; null when it has passed.
	freshUntil: string | null;
}

// The create response is the only place the secret appears.
export interface CreatedApiToken {
	token: ApiTokenSummary;
	secret: string;
}

export function isTokenScope(value: unknown): value is TokenScope {
	return typeof value === 'string' && (tokenScopes as readonly string[]).includes(value);
}

export function parseCreateToken(value: unknown): CreateTokenInput {
	if (typeof value !== 'object' || value === null || Array.isArray(value))
		throw new LinkInputError('body', 'Send a JSON object.');
	const body = value as Record<string, unknown>;
	const name = typeof body.name === 'string' ? body.name.trim() : '';
	if (!name || name.length > maxTokenNameLength || /\p{Cc}/u.test(name))
		throw new LinkInputError('name', `Use a name of 1 to ${maxTokenNameLength} characters.`);
	if (!Array.isArray(body.scopes) || body.scopes.length === 0 || !body.scopes.every(isTokenScope))
		throw new LinkInputError('scopes', 'Choose at least one scope.');
	const scopes = tokenScopes.filter((scope) => (body.scopes as unknown[]).includes(scope));
	const expiresInDays = body.expiresInDays;
	if (!(tokenExpiryDays as readonly unknown[]).includes(expiresInDays))
		throw new LinkInputError('expiresInDays', 'Choose 30, 90, or 365 days, or no expiry.');
	return { name, scopes, expiresInDays: expiresInDays as TokenExpiryDays };
}

function nullableString(value: unknown): value is string | null {
	return value === null || typeof value === 'string';
}

// Shape checks for API responses read by clients.
export function isApiTokenSummary(value: unknown): value is ApiTokenSummary {
	if (typeof value !== 'object' || value === null) return false;
	const token = value as Record<string, unknown>;
	return (
		typeof token.id === 'string' &&
		typeof token.name === 'string' &&
		typeof token.start === 'string' &&
		Array.isArray(token.scopes) &&
		token.scopes.every(isTokenScope) &&
		typeof token.createdAt === 'string' &&
		nullableString(token.lastUsedAt) &&
		nullableString(token.expiresAt)
	);
}

export function isApiTokenPage(value: unknown): value is ApiTokenPage {
	if (typeof value !== 'object' || value === null) return false;
	const page = value as Record<string, unknown>;
	return (
		Array.isArray(page.tokens) &&
		page.tokens.every(isApiTokenSummary) &&
		nullableString(page.freshUntil)
	);
}

export function isCreatedApiToken(value: unknown): value is CreatedApiToken {
	if (typeof value !== 'object' || value === null) return false;
	const created = value as Record<string, unknown>;
	return (
		typeof created.secret === 'string' &&
		created.secret.startsWith(tokenPrefix) &&
		isApiTokenSummary(created.token)
	);
}
