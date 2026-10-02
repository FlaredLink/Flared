// SPDX-License-Identifier: AGPL-3.0-only
// Apps connected through OAuth, such as AI assistants that use the MCP endpoint: what the
// consent page and the connected-apps list show.
import { isTokenScope, type TokenScope } from './tokens';

export const scopeDescriptions: Record<TokenScope, string> = {
	'links:read': 'See your links',
	'links:write': 'Create, edit, and turn off links',
	'analytics:read': 'See click analytics',
	'domains:read': 'See your domains',
	'usage:read': 'See your plan usage'
};

// What the consent page shows about a pending authorization request.
export interface ConsentRequest {
	client: {
		name: string;
		// The client's site, when it declares one.
		uri: string | null;
	};
	// Where the browser goes after the decision.
	redirectHost: string;
	// True when the redirect goes to this computer (localhost), such as a desktop or CLI app.
	redirectLoopback: boolean;
	scopes: TokenScope[];
	// True when the app asks to stay connected after this session (a refresh token).
	offlineAccess: boolean;
}

export interface ConnectedApp {
	clientId: string;
	name: string;
	uri: string | null;
	scopes: TokenScope[];
	connectedAt: string;
	// When the app last received an access token; null when it never did.
	lastActiveAt: string | null;
}

export interface ConnectedAppPage {
	apps: ConnectedApp[];
}

function nullableString(value: unknown): value is string | null {
	return value === null || typeof value === 'string';
}

export function isConsentRequest(value: unknown): value is ConsentRequest {
	if (typeof value !== 'object' || value === null) return false;
	const request = value as Record<string, unknown>;
	const client = request.client as Record<string, unknown> | null;
	return (
		typeof client === 'object' &&
		client !== null &&
		typeof client.name === 'string' &&
		nullableString(client.uri) &&
		typeof request.redirectHost === 'string' &&
		typeof request.redirectLoopback === 'boolean' &&
		Array.isArray(request.scopes) &&
		request.scopes.every(isTokenScope) &&
		typeof request.offlineAccess === 'boolean'
	);
}

export function isConnectedAppPage(value: unknown): value is ConnectedAppPage {
	if (typeof value !== 'object' || value === null) return false;
	const apps = (value as Record<string, unknown>).apps;
	return (
		Array.isArray(apps) &&
		apps.every((app: unknown) => {
			if (typeof app !== 'object' || app === null) return false;
			const entry = app as Record<string, unknown>;
			return (
				typeof entry.clientId === 'string' &&
				typeof entry.name === 'string' &&
				nullableString(entry.uri) &&
				Array.isArray(entry.scopes) &&
				entry.scopes.every(isTokenScope) &&
				typeof entry.connectedAt === 'string' &&
				nullableString(entry.lastActiveAt)
			);
		})
	);
}
