// SPDX-License-Identifier: AGPL-3.0-only
// The remote MCP endpoint for AI assistants. It is an OAuth 2.1 resource server: each request
// carries an access token from ./oauth, bound to this endpoint and to one workspace. The tools
// call the product API in process with that principal, so validation, scopes, idempotency,
// limits, and error codes are the API's own. No token leaves this Worker.
import type { D1Database } from '@cloudflare/workers-types/index.ts';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { createClient, FlaredApiError, type FlaredClient } from '@flared/client';
import { defaultQrSize, qrPng } from '@flared/client/qr';
import { domainStates, normalizeHostname, type Domain } from '@flared/contracts/domains';
import type { Link } from '@flared/contracts/links';
import { tokenScopes, type TokenScope } from '@flared/contracts/tokens';
import { countMcpCall, findAccessToken } from '@flared/data/oauth';
import type { ApiPrincipal } from './api';
import { accessTokenPrefix, hashOAuthToken } from './oauth/provider';
import { resolveTenant } from './tenancy';

export const mcpCallsPerMinute = 60;
const maxBodyBytes = 65_536;

type OAuthPrincipal = Extract<ApiPrincipal, { kind: 'oauth' }>;

export interface McpEndpointOptions {
	identity: D1Database;
	// The endpoint URL that tokens are bound to, such as https://api.flared.page/mcp.
	resource: string;
	// The OAuth issuer, such as https://flared.page.
	issuer: string;
	// Origins of browser apps that may call the endpoint. Requests without Origin are allowed.
	allowedOrigins: readonly string[];
	// The product API for one principal, such as createApi with authenticate returning it.
	api(principal: OAuthPrincipal): { fetch(request: Request): Response | Promise<Response> };
	now?: () => number;
}

// No tool adds or removes domains, so assistants never ask for that scope.
const mcpScopes = tokenScopes.filter((scope) => scope !== 'domains:write');

// RFC 9728 metadata for the endpoint. offline_access is a matter for the authorization server.
export function protectedResourceMetadata(resource: string, issuer: string) {
	return {
		resource,
		authorization_servers: [issuer],
		scopes_supported: [...mcpScopes],
		bearer_methods_supported: ['header'],
		resource_name: 'Flared'
	};
}

// An MCP server card (SEP-1649) for discovery. The format is a draft and may change.
export function mcpServerCard(resource: string) {
	return {
		serverInfo: { name: 'flared', title: 'Flared', version: '1.0.0' },
		description: 'Create, edit, and measure Flared short links.',
		transport: { type: 'streamable-http', endpoint: resource },
		protocolVersions: ['2026-07-28', '2025-11-25'],
		capabilities: { tools: { listChanged: false } },
		authentication: { required: true, schemes: ['oauth2'] },
		tools: Object.keys(toolScopes)
	};
}

export function protectedResourceMetadataUrl(resource: string): string {
	const url = new URL(resource);
	return `${url.origin}/.well-known/oauth-protected-resource${url.pathname.replace(/\/$/, '')}`;
}

// Tools and the scope each one needs.
const toolScopes: Record<string, TokenScope> = {
	list_links: 'links:read',
	get_link: 'links:read',
	get_link_qr: 'links:read',
	get_link_analytics: 'analytics:read',
	get_usage: 'usage:read',
	list_domains: 'domains:read',
	create_link: 'links:write',
	update_link: 'links:write',
	disable_link: 'links:write',
	enable_link: 'links:write'
};

// Results carry the link ID and nothing else internal.
const linkOutput = z.object({
	id: z.string(),
	shortUrl: z.string(),
	hostname: z.string(),
	slug: z.string(),
	destination: z.string(),
	title: z.string().nullable(),
	enabled: z.boolean(),
	createdAt: z.string(),
	updatedAt: z.string()
});
type LinkOutput = z.infer<typeof linkOutput>;
const clicks = z.object({ value: z.string(), clicks: z.number() });

const domainOutput = z.object({
	hostname: z.string(),
	state: z.enum(domainStates),
	kind: z.enum(['platform', 'workspace']),
	isDefault: z.boolean(),
	records: z.array(z.object({ type: z.literal('CNAME'), name: z.string(), value: z.string() })),
	error: z.object({ code: z.string(), message: z.string() }).nullable()
});
type DomainOutput = z.infer<typeof domainOutput>;

function domainResult(domain: Domain): DomainOutput {
	return {
		hostname: domain.hostname,
		state: domain.state,
		kind: domain.kind,
		isDefault: domain.isDefault,
		records: domain.records,
		error: domain.error
	};
}

function linkResult(link: Link): LinkOutput {
	return {
		id: link.id,
		shortUrl: link.shortUrl,
		hostname: link.hostname,
		slug: link.slug,
		destination: link.destination,
		title: link.title,
		enabled: link.enabled,
		createdAt: link.createdAt,
		updatedAt: link.updatedAt
	};
}

type ImageContent = { type: 'image'; data: string; mimeType: string };

// extra comes before the JSON text, such as an image the result describes.
function success<T extends Record<string, unknown>>(value: T, extra: ImageContent[] = []) {
	return {
		content: [...extra, { type: 'text' as const, text: JSON.stringify(value) }],
		structuredContent: value
	};
}

function failure(error: unknown) {
	const known = error instanceof FlaredApiError;
	const body = {
		error: {
			code: known ? error.code : 'SERVICE_UNAVAILABLE',
			message: known ? error.message : 'The service is not available. Try again.',
			...(known && error.field ? { field: error.field } : {})
		}
	};
	return { content: [{ type: 'text' as const, text: JSON.stringify(body) }], isError: true };
}

async function attempt<T extends Record<string, unknown>>(
	operation: () => Promise<T>,
	extra: (value: T) => Promise<ImageContent[]> = async () => []
) {
	try {
		const value = await operation();
		return success(value, await extra(value));
	} catch (error) {
		if (!(error instanceof FlaredApiError))
			console.error(JSON.stringify({ event: 'mcp_tool_failed' }));
		return failure(error);
	}
}

// The rules for adding a domain need three labels, so a platform hostname such as flared.link
// falls back to a plain lowercase comparison.
function hostnameOf(value: string): string {
	try {
		return normalizeHostname(value);
	} catch {
		return value.trim().toLowerCase().replace(/\.$/, '');
	}
}

async function sha256(value: string): Promise<string> {
	const digest = new Uint8Array(
		await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
	);
	return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function base64(bytes: Uint8Array): string {
	let binary = '';
	for (let at = 0; at < bytes.length; at += 0x8000)
		binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
	return btoa(binary);
}

const slug = z.string().regex(/^[a-z0-9-]{3,64}$/);

function createTools(client: FlaredClient, grantKey: string, now: () => number): McpServer {
	const server = new McpServer({ name: 'flared', title: 'Flared', version: '1.0.0' });

	async function findLink(idOrSlug: string): Promise<Link> {
		try {
			return await client.getLink(idOrSlug);
		} catch (error) {
			if (
				!(error instanceof FlaredApiError && error.code === 'NOT_FOUND') ||
				!slug.safeParse(idOrSlug).success
			)
				throw error;
			const page = await client.listLinks({ search: idOrSlug, limit: 100 });
			const match = page.links.find((link) => link.slug === idOrSlug);
			if (!match) throw error;
			return match;
		}
	}

	// A hostname from list_domains; platform hostnames such as flared.link count too.
	async function findActiveDomain(hostname: string): Promise<Domain> {
		const { domains } = await client.listDomains();
		const match = domains.find((domain) => domain.hostname === hostname);
		if (!match)
			throw new FlaredApiError(
				'NOT_FOUND',
				`No domain ${hostname} in this workspace.`,
				404,
				null,
				null,
				'domain'
			);
		if (match.state !== 'active')
			throw new FlaredApiError(
				'DOMAIN_UNAVAILABLE',
				`${hostname} is ${match.state}. Links can use it once it is active.`,
				422,
				null,
				null,
				'domain'
			);
		return match;
	}

	server.registerTool(
		'list_links',
		{
			title: 'List links',
			description:
				'Lists short links in the workspace, newest first, with clicks in the last 30 days.',
			inputSchema: z.object({
				search: z
					.string()
					.max(100)
					.optional()
					.describe('Text to find in the slug, title, or destination.'),
				limit: z.number().int().min(1).max(100).optional(),
				cursor: z.string().max(500).optional().describe('nextCursor from the previous page.')
			}),
			outputSchema: z.object({
				links: z.array(linkOutput.extend({ clicksLast30Days: z.number().nullable() })),
				nextCursor: z.string().nullable()
			}),
			annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
		},
		({ search, limit, cursor }) =>
			attempt(async () => {
				const page = await client.listLinks({ search, limit, cursor });
				return {
					links: page.links.map((link) => ({
						...linkResult(link),
						clicksLast30Days: link.clicksLast30Days
					})),
					nextCursor: page.nextCursor
				};
			})
	);

	server.registerTool(
		'get_link',
		{
			title: 'Get a link',
			description: 'Gets one short link by its ID or slug.',
			inputSchema: z.object({ link: z.string().min(1).max(100).describe('The link ID or slug.') }),
			outputSchema: z.object({ link: linkOutput }),
			annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
		},
		({ link }) => attempt(async () => ({ link: linkResult(await findLink(link)) }))
	);

	server.registerTool(
		'get_link_qr',
		{
			title: 'Get a link QR code',
			description: 'Gets a PNG QR code of a short URL, by link ID or slug.',
			inputSchema: z.object({ link: z.string().min(1).max(100).describe('The link ID or slug.') }),
			outputSchema: z.object({
				shortUrl: z.string(),
				mimeType: z.literal('image/png'),
				size: z.number()
			}),
			annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
		},
		({ link }) =>
			attempt(
				async () => ({
					shortUrl: (await findLink(link)).shortUrl,
					mimeType: 'image/png' as const,
					size: defaultQrSize
				}),
				async ({ shortUrl, mimeType, size }) => [
					{ type: 'image', data: base64(await qrPng(shortUrl, size)), mimeType }
				]
			)
	);

	server.registerTool(
		'get_link_analytics',
		{
			title: 'Get link analytics',
			description:
				'Gets clicks for one link by day, country, device, and referrer. The range is in UTC days and defaults to the last 30 days.',
			inputSchema: z.object({
				link: z.string().min(1).max(100).describe('The link ID or slug.'),
				from: z
					.string()
					.regex(/^\d{4}-\d{2}-\d{2}$/)
					.optional()
					.describe('First day, YYYY-MM-DD.'),
				to: z
					.string()
					.regex(/^\d{4}-\d{2}-\d{2}$/)
					.optional()
					.describe('Last day, YYYY-MM-DD.')
			}),
			outputSchema: z.object({
				analytics: z.object({
					linkId: z.string(),
					from: z.string(),
					to: z.string(),
					total: z.number(),
					days: z.array(z.object({ day: z.string(), clicks: z.number() })),
					countries: z.array(clicks),
					devices: z.array(clicks),
					referrers: z.array(clicks),
					asOf: z.string()
				})
			}),
			annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
		},
		({ link, from, to }) =>
			attempt(async () => {
				const found = await findLink(link);
				return { analytics: await client.getAnalytics(found.id, { from, to }) };
			})
	);

	server.registerTool(
		'get_usage',
		{
			title: 'Get usage',
			description: 'Gets the clicks counted this calendar month (UTC) and the monthly click limit.',
			inputSchema: z.object({}),
			outputSchema: z.object({
				usage: z.object({
					month: z.string(),
					clicks: z.number(),
					clickLimit: z.number(),
					asOf: z.string()
				})
			}),
			annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
		},
		() => attempt(async () => ({ usage: await client.getUsage() }))
	);

	server.registerTool(
		'list_domains',
		{
			title: 'List domains',
			description:
				'Lists the domains links can use, with their status and the DNS records to create. Only active domains serve links.',
			inputSchema: z.object({}),
			outputSchema: z.object({
				domains: z.array(domainOutput),
				used: z.number(),
				limit: z.number()
			}),
			annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
		},
		() =>
			attempt(async () => {
				const page = await client.listDomains();
				return { domains: page.domains.map(domainResult), used: page.used, limit: page.limit };
			})
	);

	server.registerTool(
		'create_link',
		{
			title: 'Create a link',
			description:
				'Creates a public short link to a destination URL. The same request repeated within five minutes returns the first link.',
			inputSchema: z.object({
				destination: z.string().min(1).max(4096).describe('The full URL, starting with https://.'),
				slug: slug.optional().describe('The path after the domain. Generated when absent.'),
				title: z.string().max(200).optional(),
				domain: z
					.string()
					.min(1)
					.max(253)
					.optional()
					.describe('An active hostname from list_domains. The default domain when absent.')
			}),
			outputSchema: z.object({ link: linkOutput, replayed: z.boolean() }),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true
			}
		},
		(input) =>
			attempt(async () => {
				const { domain, ...fields } = input;
				const hostname = domain === undefined ? undefined : hostnameOf(domain);
				const domainId = hostname === undefined ? undefined : (await findActiveDomain(hostname)).id;
				const window = Math.floor(now() / 300_000);
				// The key input for a call without a domain is unchanged from before domains existed.
				const keyed = hostname === undefined ? fields : { ...fields, domain: hostname };
				const key = `mcp-${await sha256(JSON.stringify([grantKey, window, keyed]))}`;
				const created = await client.createLink({
					...fields,
					...(domainId ? { domainId } : {}),
					idempotencyKey: key
				});
				return { link: linkResult(created.link), replayed: created.replayed };
			})
	);

	server.registerTool(
		'update_link',
		{
			title: 'Update a link',
			description: 'Changes the destination or title of a link. The short URL stays the same.',
			inputSchema: z.object({
				link: z.string().min(1).max(100).describe('The link ID or slug.'),
				destination: z.string().min(1).max(4096).optional(),
				title: z.string().max(200).nullable().optional().describe('null removes the title.')
			}),
			outputSchema: z.object({ link: linkOutput }),
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: true,
				openWorldHint: true
			}
		},
		({ link, destination, title }) =>
			attempt(async () => {
				const found = await findLink(link);
				return { link: linkResult(await client.updateLink(found.id, { destination, title })) };
			})
	);

	for (const [name, enabled] of [
		['disable_link', false],
		['enable_link', true]
	] as const)
		server.registerTool(
			name,
			{
				title: enabled ? 'Turn on a link' : 'Turn off a link',
				description: enabled
					? 'Turns a link back on, so its short URL redirects again.'
					: 'Turns a link off, so its short URL stops redirecting. It can be turned on again.',
				inputSchema: z.object({
					link: z.string().min(1).max(100).describe('The link ID or slug.')
				}),
				outputSchema: z.object({ link: linkOutput }),
				annotations: {
					readOnlyHint: false,
					destructiveHint: !enabled,
					idempotentHint: true,
					openWorldHint: true
				}
			},
			({ link }) =>
				attempt(async () => {
					const found = await findLink(link);
					return { link: linkResult(await client.updateLink(found.id, { enabled })) };
				})
		);

	return server;
}

function jsonRpcError(
	status: number,
	message: string,
	headers: Record<string, string> = {}
): Response {
	return Response.json(
		{ jsonrpc: '2.0', error: { code: -32000, message }, id: null },
		{ status, headers: { 'cache-control': 'no-store', ...headers } }
	);
}

// The tool a tools/call request names, or null.
function calledTool(body: unknown): string | null {
	if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
	const message = body as Record<string, unknown>;
	if (message.method !== 'tools/call') return null;
	const params = message.params as Record<string, unknown> | null;
	return typeof params?.name === 'string' ? params.name : null;
}

export function createMcpEndpoint(options: McpEndpointOptions) {
	const now = options.now ?? Date.now;
	const metadataUrl = protectedResourceMetadataUrl(options.resource);
	const challenge = (extra = '') =>
		`Bearer resource_metadata="${metadataUrl}", scope="${mcpScopes.join(' ')}"${extra}`;

	return async function handle(request: Request): Promise<Response> {
		const origin = request.headers.get('origin');
		if (origin !== null && !options.allowedOrigins.includes(origin))
			return jsonRpcError(403, 'Origin not allowed.');
		if (request.method !== 'POST')
			return new Response(null, { status: 405, headers: { allow: 'POST' } });

		const match = /^Bearer +(\S+)$/i.exec(request.headers.get('authorization') ?? '');
		if (!match)
			return jsonRpcError(401, 'Sign in to continue.', { 'www-authenticate': challenge() });
		const token = match[1];
		const time = now();
		const stored =
			token.startsWith(accessTokenPrefix) && token.length <= 128
				? await findAccessToken(
						options.identity,
						await hashOAuthToken(token.slice(accessTokenPrefix.length), 'access_token'),
						time
					)
				: null;
		// The audience check: the token must be bound to this endpoint. The person must still
		// belong to the workspace the grant is for.
		const tenant =
			stored && stored.resources.includes(options.resource)
				? await resolveTenant(options.identity, stored.userId)
				: null;
		if (!stored || tenant?.status !== 'active' || tenant.tenantId !== stored.tenantId)
			return jsonRpcError(401, 'The access token is not valid.', {
				'www-authenticate': challenge(', error="invalid_token"')
			});
		const scopes = stored.scopes.filter((scope): scope is TokenScope =>
			(tokenScopes as readonly string[]).includes(scope)
		);

		if (Number(request.headers.get('content-length') ?? '0') > maxBodyBytes)
			return jsonRpcError(413, 'The request is too large.');
		const bytes = await request.arrayBuffer();
		if (bytes.byteLength > maxBodyBytes) return jsonRpcError(413, 'The request is too large.');
		let body: unknown = null;
		try {
			body = JSON.parse(new TextDecoder().decode(bytes));
		} catch {
			// The MCP handler answers malformed JSON.
		}
		const needed = toolScopes[calledTool(body) ?? ''];
		if (needed && !scopes.includes(needed)) {
			const wanted = tokenScopes.filter((scope) => scope === needed || scopes.includes(scope));
			return jsonRpcError(403, `This app needs the ${needed} scope.`, {
				'www-authenticate': `Bearer error="insufficient_scope", scope="${wanted.join(' ')}", resource_metadata="${metadataUrl}"`
			});
		}

		const grantKey = `${stored.clientId}\u0000${stored.userId}\u0000${stored.tenantId}`;
		const budget = await countMcpCall(options.identity, grantKey, time, mcpCallsPerMinute);
		if (!budget.allowed)
			return jsonRpcError(429, 'Too many requests. Try again soon.', {
				'retry-after': String(budget.retryAfterSeconds)
			});

		const api = options.api({
			kind: 'oauth',
			userId: stored.userId,
			tenantId: stored.tenantId,
			scopes,
			clientId: stored.clientId
		});
		const client = createClient({
			baseUrl: `${new URL(options.resource).origin}/v1`,
			token: 'in-process',
			retries: 0,
			fetch: async (input, init) => api.fetch(new Request(input, init))
		});
		const handler = createMcpHandler(() => createTools(client, grantKey, now), {
			responseMode: 'json',
			legacy: 'stateless'
		});
		const headers = new Headers(request.headers);
		headers.delete('authorization');
		headers.delete('cookie');
		const response = await handler.fetch(
			new Request(request.url, { method: 'POST', headers, body: bytes })
		);
		const result = new Response(response.body, response);
		result.headers.set('cache-control', 'no-store');
		return result;
	};
}
