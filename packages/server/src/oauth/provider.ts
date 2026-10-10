// SPDX-License-Identifier: AGPL-3.0-only
// The OAuth 2.1 authorization server that lets AI assistants connect to the MCP endpoint. It is a
// separate Better Auth instance: the D1 proof guards of the sign-in instance refuse its plugins,
// and it stores authorization codes through the default verification storage. Only the routes
// in ./routes reach it.
import type { D1Database } from '@cloudflare/workers-types/index.ts';
import { betterAuth } from 'better-auth';
import { cimd } from '@better-auth/cimd';
import { mcp } from '@better-auth/mcp';
import { tokenScopes } from '@flared/contracts/tokens';
import { createIdentityAdapter } from '@flared/data/identity-adapter';
import { resolveTenant } from '../tenancy';
import { createSessionOptions } from '../auth/options';

export const oauthScopes = [...tokenScopes, 'offline_access'] as const;
export const accessTokenPrefix = 'flo_at_';
export const refreshTokenPrefix = 'flo_rt_';
export const accessTokenSeconds = 3600;
export const refreshTokenSeconds = 30 * 86_400;

export interface OAuthServerConfig {
	// The exact application origin. It is the issuer, and the sign-in session lives there.
	origin: string;
	secret: string;
	// The MCP endpoint, such as https://api.flared.page/mcp. Every token is bound to it.
	resource: string;
	// Application pages, as paths on the origin.
	loginPath: string;
	consentPath: string;
	// Fetches client ID metadata documents; see createMetadataFetch.
	fetchClientMetadata: typeof fetch;
}

// Client ID metadata documents are fetched over HTTPS without following redirects. The library
// limits time and size. On Cloudflare, the global_fetch_strictly_public compatibility flag keeps
// the fetch away from private addresses.
export function createMetadataFetch(fetchImpl: typeof fetch = fetch): typeof fetch {
	return async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : input);
		if (url.protocol !== 'https:') throw new Error('Client metadata must use HTTPS');
		const response = await fetchImpl(url, { ...init, redirect: 'manual' });
		if (response.status >= 300 && response.status < 400) {
			await response.body?.cancel();
			throw new Error('Client metadata must not redirect');
		}
		return response;
	};
}

const tokenKinds: Record<string, string> = {
	authorization_code: 'oauth-code',
	access_token: 'oauth-access',
	refresh_token: 'oauth-refresh'
};

// Codes and tokens are stored as a labelled SHA-256 hash. The label keeps an authorization code
// apart from every other proof in the shared verification table.
export async function hashOAuthToken(token: string, type: string): Promise<string> {
	const label = tokenKinds[type];
	if (!label) throw new Error('Unknown OAuth token type');
	const digest = new Uint8Array(
		await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
	);
	let binary = '';
	for (const byte of digest) binary += String.fromCharCode(byte);
	return `${label}:${btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

function sessionOf(context: { user: { id?: unknown }; session: { id?: unknown } }): {
	userId: string;
	sessionId: string;
} {
	const userId = context.user.id;
	const sessionId = context.session.id;
	if (typeof userId !== 'string' || typeof sessionId !== 'string')
		throw new Error('Session without a user');
	return { userId, sessionId };
}

export function createOAuthServer(db: D1Database, config: OAuthServerConfig) {
	return betterAuth({
		...createSessionOptions(config.origin),
		// Endpoints live at the origin root, such as /oauth2/token, so the issuer is the origin.
		basePath: '/',
		secret: config.secret,
		database: createIdentityAdapter(db),
		// The routes apply their own limits; the library's limiter keeps state in memory.
		rateLimit: { enabled: false },
		logger: { disabled: true },
		// Errors before the redirect URI is trusted are shown on the consent page.
		onAPIError: { errorURL: `${config.origin}${config.consentPath}` },
		plugins: [
			mcp({
				resource: config.resource,
				loginPage: config.loginPath,
				consentPage: config.consentPath,
				scopes: [...oauthScopes],
				grantTypes: ['authorization_code', 'refresh_token'],
				disableJwtPlugin: true,
				accessTokenExpiresIn: accessTokenSeconds,
				refreshTokenExpiresIn: refreshTokenSeconds,
				codeExpiresIn: 300,
				storeTokens: { hash: hashOAuthToken },
				prefix: { opaqueAccessToken: accessTokenPrefix, refreshToken: refreshTokenPrefix },
				allowDynamicClientRegistration: true,
				allowUnauthenticatedClientRegistration: true,
				clientRegistrationDefaultScopes: [...oauthScopes],
				// The grant belongs to the session's active workspace, never to a request parameter.
				postLogin: {
					page: config.consentPath,
					shouldRedirect: () => false,
					async consentReferenceId(context) {
						const tenant = await resolveTenant(db, sessionOf(context));
						if (tenant.status !== 'active' || tenant.suspension)
							throw new Error('No active workspace');
						return tenant.tenantId;
					}
				}
			}),
			cimd({
				fetchClientMetadataResource: config.fetchClientMetadata,
				metadataProfile: 'mcp-2026-07-28'
			})
		]
	});
}

export type OAuthServer = ReturnType<typeof createOAuthServer>;
