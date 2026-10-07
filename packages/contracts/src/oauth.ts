// SPDX-License-Identifier: AGPL-3.0-only
// Apps connected through OAuth, such as AI assistants that use the MCP endpoint: what the
// consent page and the connected-apps list show.
import { isTokenScope, type TokenScope } from './tokens';

export const scopeDescriptions: Record<TokenScope, string> = {
	'links:read': 'See your links',
	'links:write': 'Create, edit, and turn off links',
	'analytics:read': 'See click analytics',
	'domains:read': 'See your domains',
	'domains:write': 'Add and remove domains',
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

// An assistant whose OAuth codes can reach only that assistant: every redirect URI of the client
// is the assistant's own. The app chooses its name and icon, so they prove nothing; the redirect
// URIs decide where codes go. A loopback redirect can belong to any local program, so it never
// matches.
export type KnownAssistant = 'claude' | 'chatgpt' | 'cursor';

function assistantOf(redirectUri: string): KnownAssistant | null {
	let url: URL;
	try {
		url = new URL(redirectUri);
	} catch {
		return null;
	}
	if (url.href === 'https://claude.ai/api/mcp/auth_callback') return 'claude';
	if (
		url.protocol === 'https:' &&
		url.host === 'chatgpt.com' &&
		(url.pathname === '/connector_platform_oauth_redirect' ||
			url.pathname.startsWith('/connector/oauth/'))
	)
		return 'chatgpt';
	if (url.protocol === 'cursor:') return 'cursor';
	return null;
}

export function knownAssistant(redirectUris: readonly string[]): KnownAssistant | null {
	const [first, ...rest] = redirectUris.map(assistantOf);
	return first && rest.every((assistant) => assistant === first) ? first : null;
}

export interface ConnectedApp {
	clientId: string;
	name: string;
	// Set only when knownAssistant matches the app's redirect URIs.
	assistant: KnownAssistant | null;
	uri: string | null;
	scopes: TokenScope[];
	connectedAt: string;
	// When the app last received an access token; null when it never did.
	lastActiveAt: string | null;
}

export interface ConnectedAppPage {
	apps: ConnectedApp[];
}

// Parameters that the authorization server adds to the query it signs. The rest is the app's
// original authorization request.
const signatureParams = new Set(['sig', 'exp', 'ba_iat', 'ba_pl', 'ba_param']);

// The sign-in page receives a signed authorization request. After sign-in, it sends the browser
// to this path to continue the request, which the server validates again. Returns null when the
// query holds no authorization request.
export function resumeAuthorizationPath(signedQuery: string): string | null {
	const params = new URLSearchParams(signedQuery);
	if (!params.get('client_id') || params.get('response_type') !== 'code') return null;
	const query = new URLSearchParams();
	for (const [key, value] of params) if (!signatureParams.has(key)) query.append(key, value);
	return `/oauth2/authorize?${query}`;
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
				(entry.assistant === null ||
					entry.assistant === 'claude' ||
					entry.assistant === 'chatgpt' ||
					entry.assistant === 'cursor') &&
				nullableString(entry.uri) &&
				Array.isArray(entry.scopes) &&
				entry.scopes.every(isTokenScope) &&
				typeof entry.connectedAt === 'string' &&
				nullableString(entry.lastActiveAt)
			);
		})
	);
}
