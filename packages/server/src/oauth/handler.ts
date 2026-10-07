// SPDX-License-Identifier: AGPL-3.0-only
// An edition's composition of the OAuth authorization server, the MCP endpoint, and their
// discovery documents. The edition passes its origin, secrets, and the MCP resource URL from
// deployment configuration.
import type { D1Database } from '@cloudflare/workers-types/index.ts';
import {
	createMcpEndpoint,
	mcpServerCard,
	protectedResourceMetadata,
	type McpEndpointOptions
} from '../mcp';
import { authResponseHeaders } from '../web/forward';
import { keyedHash } from '../auth/limits';
import { createMetadataFetch } from './provider';
import { createOAuthRoutes } from './routes';

export const loginPath = '/app/login';
export const consentPath = '/app/oauth/consent';

export interface OAuthSite {
	// The application origin, which is also the OAuth issuer.
	origin: string;
	secret: string;
	// Keys registration budgets, so they store no addresses.
	rateLimitSecret: string;
	// The MCP endpoint URL that tokens are bound to.
	resource: string;
}

export function oauthUnavailable(): Response {
	return new Response(
		JSON.stringify({ error: 'temporarily_unavailable', error_description: 'Try again later.' }),
		{
			status: 503,
			headers: authResponseHeaders({ 'content-type': 'application/json' })
		}
	);
}

// A keyed hash of the connecting address, so registration budgets store no addresses.
async function sourceKey(secret: string, request: Request): Promise<string | null> {
	const address = request.headers.get('cf-connecting-ip');
	if (!address) return null;
	return keyedHash(secret, `oauth-source:${address}`);
}

// The authorization server routes on the app origin.
export function handleOAuth(request: Request, site: OAuthSite, identity: D1Database) {
	return createOAuthRoutes({
		db: identity,
		config: {
			origin: site.origin,
			secret: site.secret,
			resource: site.resource,
			loginPath,
			consentPath,
			fetchClientMetadata: createMetadataFetch()
		},
		sourceKey: (incoming) => sourceKey(site.rateLimitSecret, incoming)
	}).fetch(request);
}

export function discoveryDocument(request: Request, body: unknown): Response {
	if (request.method !== 'GET' && request.method !== 'HEAD')
		return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } });
	return new Response(request.method === 'HEAD' ? null : JSON.stringify(body), {
		headers: {
			'content-type': 'application/json',
			'cache-control': 'public, max-age=3600',
			'access-control-allow-origin': '*'
		}
	});
}

// RFC 9728 metadata of the MCP endpoint.
export function protectedResourceDocument(
	request: Request,
	resource: string,
	issuer: string
): Response {
	return discoveryDocument(request, protectedResourceMetadata(resource, issuer));
}

// /.well-known/mcp/server-card.json
export function serverCardDocument(request: Request, resource: string): Response {
	return discoveryDocument(request, mcpServerCard(resource));
}

// /.well-known/ai-catalog.json (ARD): the MCP server. The OpenAPI description is listed in
// /.well-known/api-catalog, because ARD has no media type for it.
export function aiCatalogDocument(
	request: Request,
	site: { origin: string; resource: string; displayName: string }
): Response {
	const host = new URL(site.origin).hostname;
	return discoveryDocument(request, {
		specVersion: '1.0',
		host: { displayName: site.displayName, identifier: `did:web:${host}` },
		entries: [
			{
				identifier: `urn:air:${host}:mcp:links`,
				displayName: `${site.displayName} MCP server`,
				description: 'Create, edit, and measure short links from an AI assistant. Uses OAuth.',
				type: 'application/mcp-server-card+json',
				url: `${site.origin}/.well-known/mcp/server-card.json`,
				representativeQueries: [
					'shorten this URL',
					'how many clicks did my link get this week',
					'change where my short link points',
					'turn off a short link'
				]
			}
		]
	});
}

// The MCP endpoint. Browser apps may call it only from the app origin; assistants call it from
// their servers without an Origin. api builds the product API for the OAuth principal.
export async function handleMcp(
	request: Request,
	site: Pick<OAuthSite, 'origin' | 'resource'>,
	identity: D1Database,
	api: McpEndpointOptions['api']
): Promise<Response> {
	try {
		return await createMcpEndpoint({
			identity,
			resource: site.resource,
			issuer: site.origin,
			allowedOrigins: [site.origin],
			api
		})(request);
	} catch {
		console.error(JSON.stringify({ event: 'mcp_request_failed' }));
		return Response.json(
			{ jsonrpc: '2.0', error: { code: -32603, message: 'Try again later.' }, id: null },
			{ status: 503, headers: { 'cache-control': 'no-store' } }
		);
	}
}
