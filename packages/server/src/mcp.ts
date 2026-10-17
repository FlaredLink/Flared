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
import {
	domainSetups,
	domainStates,
	normalizeHostname,
	type Domain
} from '@flared/contracts/domains';
import {
	automationActionTypes,
	automationResults,
	maxApplyLinks,
	maxAutomationIdLength
} from '@flared/contracts/automations';
import {
	blockReasons,
	LinkInputError,
	maxUtmLength,
	withUtm,
	type ImportLinksResult,
	type Link
} from '@flared/contracts/links';
import { tokenScopes, type TokenScope } from '@flared/contracts/tokens';
import { countMcpCall, findAccessToken } from '@flared/data/oauth';
import { defaultImportItemsPerRequest, type ApiPrincipal } from './api';
import { accessTokenPrefix, hashOAuthToken } from './oauth/provider';
import { resolveTenant } from './tenancy';
import { recordProductEvent, type ProductEvents } from './events';

export const mcpCallsPerMinute = 60;
// Items in one import_links call. The endpoint does not see a deployment's API options, so it
// uses the API default; an API with a lower value answers TOO_MANY_ITEMS.
export const mcpImportItemsPerCall = defaultImportItemsPerRequest;
// An export_links result stays within this many bytes of JSON, so a page of long destinations
// still fits an assistant's context.
export const mcpExportResultBytes = 48 * 1024;
const exportPageSize = 50;
const maxExportPageSize = 100;
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
	// The edition's product analytics. Without it, no tool call is recorded.
	events?: ProductEvents;
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
	export_links: 'links:read',
	list_automations: 'links:read',
	create_link: 'links:write',
	import_links: 'links:write',
	update_link: 'links:write',
	disable_link: 'links:write',
	enable_link: 'links:write',
	apply_automation: 'links:write',
	remove_automation: 'links:write'
};

const deviceDestination = (os: string, extra = '') =>
	z
		.string()
		.max(4096)
		.describe(
			`Where ${os} visitors go instead of destination: an https URL or an app link such as myapp://path${os === 'Android' ? ' or intent://…' : ''}.${extra}`
		);
const utmValue = z.string().max(maxUtmLength);
const utmInput = z
	.object({
		source: utmValue.optional(),
		medium: utmValue.optional(),
		campaign: utmValue.optional(),
		term: utmValue.optional(),
		content: utmValue.optional()
	})
	.describe('utm_source, utm_medium, utm_campaign, utm_term, and utm_content for the destination.');

// Results carry the link ID and nothing else internal. Output objects are loose, so a client
// with an earlier tool list still accepts a result after a field is added.
const linkOutput = z.looseObject({
	id: z.string(),
	shortUrl: z.string(),
	hostname: z.string(),
	slug: z.string(),
	destination: z.string(),
	title: z.string().nullable(),
	iosDestination: z.string().nullable(),
	androidDestination: z.string().nullable(),
	enabled: z.boolean(),
	blocked: z.looseObject({ reason: z.enum(blockReasons) }).nullable(),
	createdAt: z.string(),
	updatedAt: z.string()
});
type LinkOutput = z.infer<typeof linkOutput>;
const clicks = z.looseObject({ value: z.string(), clicks: z.number() });

const importOutput = z.looseObject({
	dryRun: z.boolean(),
	results: z.array(
		z.looseObject({
			index: z.number(),
			status: z.enum(['ready', 'created', 'failed']),
			link: linkOutput.optional(),
			error: z
				.looseObject({ code: z.string(), message: z.string(), field: z.string().optional() })
				.optional()
		})
	),
	summary: z.looseObject({
		ready: z.number().optional(),
		created: z.number().optional(),
		failed: z.number()
	})
});
type ImportOutput = z.infer<typeof importOutput>;

function importResult(result: ImportLinksResult): ImportOutput {
	return {
		dryRun: result.dryRun,
		results: result.results.map(({ index, status, link, error }) => ({
			index,
			status,
			...(link ? { link: linkResult(link) } : {}),
			...(error ? { error: { ...error } } : {})
		})),
		summary: result.summary
	};
}

function importSummary({ dryRun, results }: ImportOutput): string {
	const failed = results.filter((item) => item.status === 'failed').length;
	const done = results.length - failed;
	return dryRun
		? `Dry run: ${done} of ${results.length} items are ready and ${failed} would fail. Nothing was created.`
		: `Created ${done} of ${results.length} links; ${failed} failed.`;
}

// An exported link: item holds only fields of create_link, so it goes to import_links as is.
const exportedLinkOutput = z.looseObject({
	id: z.string(),
	shortUrl: z.string(),
	status: z.enum(['active', 'disabled', 'blocked']),
	createdAt: z.string(),
	updatedAt: z.string(),
	item: z.looseObject({
		destination: z.string(),
		slug: z.string(),
		domain: z.string(),
		title: z.string().optional(),
		iosDestination: z.string().optional(),
		androidDestination: z.string().optional()
	})
});
type ExportedLinkOutput = z.infer<typeof exportedLinkOutput>;

function exportedLink(link: Link): ExportedLinkOutput {
	const { title, iosDestination, androidDestination } = link;
	return {
		id: link.id,
		shortUrl: link.shortUrl,
		status: link.blocked !== null ? 'blocked' : link.enabled ? 'active' : 'disabled',
		createdAt: link.createdAt,
		updatedAt: link.updatedAt,
		item: {
			destination: link.destination,
			slug: link.slug,
			domain: link.hostname,
			...(title !== null ? { title } : {}),
			...(iosDestination ? { iosDestination } : {}),
			...(androidDestination ? { androidDestination } : {})
		}
	};
}

const triggerOutput = z.looseObject({
	type: z.string(),
	days: z.number().optional(),
	clicks: z.number().optional()
});
const automationOutput = z.looseObject({
	id: z.string(),
	name: z.string(),
	enabled: z.boolean(),
	trigger: triggerOutput,
	actions: z.array(z.looseObject({ type: z.enum(automationActionTypes) })),
	links: z.number()
});
const linkAutomationOutput = z.looseObject({
	automationId: z.string(),
	name: z.string(),
	enabled: z.boolean(),
	trigger: triggerOutput,
	state: z.enum(['waiting', 'done', 'failed', 'skipped']),
	endsAt: z.string().nullable(),
	dueAt: z.string().nullable(),
	firedAt: z.string().nullable(),
	result: z.enum(automationResults).nullable(),
	appliedAt: z.string()
});
const automationId = z
	.string()
	.min(1)
	.max(maxAutomationIdLength)
	.describe('An automation ID from list_automations.');

const domainOutput = z.looseObject({
	hostname: z.string(),
	state: z.enum(domainStates),
	kind: z.enum(['platform', 'workspace']),
	isDefault: z.boolean(),
	setup: z.enum(domainSetups).nullable(),
	records: z.array(
		z.looseObject({ type: z.literal('CNAME'), name: z.string(), value: z.string() })
	),
	error: z.looseObject({ code: z.string(), message: z.string() }).nullable()
});
type DomainOutput = z.infer<typeof domainOutput>;

function domainResult(domain: Domain): DomainOutput {
	return {
		hostname: domain.hostname,
		state: domain.state,
		kind: domain.kind,
		isDefault: domain.isDefault,
		setup: domain.setup,
		records: domain.records.map(({ type, name, value }) => ({ type, name, value })),
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
		iosDestination: link.iosDestination ?? null,
		androidDestination: link.androidDestination ?? null,
		enabled: link.enabled,
		blocked: link.blocked,
		createdAt: link.createdAt,
		updatedAt: link.updatedAt
	};
}

type ExtraContent =
	{ type: 'image'; data: string; mimeType: string } | { type: 'text'; text: string };

// extra comes before the JSON text, such as an image or a summary of the result.
function success<T extends Record<string, unknown>>(value: T, extra: ExtraContent[] = []) {
	return {
		content: [...extra, { type: 'text' as const, text: JSON.stringify(value) }],
		structuredContent: value
	};
}

function failure(error: unknown) {
	if (error instanceof LinkInputError)
		return {
			content: [
				{
					type: 'text' as const,
					text: JSON.stringify({
						error: { code: 'INVALID_INPUT', message: error.message, field: error.field }
					})
				}
			],
			isError: true
		};
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
	extra: (value: T) => Promise<ExtraContent[]> = async () => []
) {
	try {
		const value = await operation();
		return success(value, await extra(value));
	} catch (error) {
		if (!(error instanceof FlaredApiError) && !(error instanceof LinkInputError))
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

const createLinkInput = z.object({
	destination: z.string().min(1).max(4096).describe('The full URL, starting with https://.'),
	slug: slug.optional().describe('The path after the domain. Generated when absent.'),
	title: z.string().max(200).optional(),
	domain: z
		.string()
		.min(1)
		.max(253)
		.optional()
		.describe('An active hostname from list_domains. The default domain when absent.'),
	iosDestination: deviceDestination('iPhone').optional(),
	androidDestination: deviceDestination('Android').optional(),
	utm: utmInput.optional()
});
type CreateLinkFields = z.infer<typeof createLinkInput>;

// A create request's fields: utm goes into the destination, and domain becomes domainId.
function createFields({ domain: _domain, utm, ...given }: CreateLinkFields) {
	return utm ? { ...given, destination: withUtm(given.destination, utm) } : given;
}

// A hostname from list_domains; platform hostnames such as flared.link count too.
function activeDomain(domains: Domain[], hostname: string, field: string): Domain {
	const match = domains.find((domain) => domain.hostname === hostname);
	if (!match)
		throw new FlaredApiError(
			'NOT_FOUND',
			`No domain ${hostname} in this workspace.`,
			404,
			null,
			null,
			field
		);
	if (match.state !== 'active')
		throw new FlaredApiError(
			'DOMAIN_UNAVAILABLE',
			`${hostname} is ${match.state}. Links can use it once it is active.`,
			422,
			null,
			null,
			field
		);
	return match;
}

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

	async function findActiveDomain(hostname: string): Promise<Domain> {
		return activeDomain((await client.listDomains()).domains, hostname, 'domain');
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
			outputSchema: z.looseObject({
				links: z.array(linkOutput.extend({ clicksLast30Days: z.number().nullable() })),
				nextCursor: z.string().nullable()
			}),
			annotations: {
				title: 'List links',
				readOnlyHint: true,
				destructiveHint: false,
				openWorldHint: false
			}
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
			outputSchema: z.looseObject({ link: linkOutput }),
			annotations: {
				title: 'Get a link',
				readOnlyHint: true,
				destructiveHint: false,
				openWorldHint: false
			}
		},
		({ link }) => attempt(async () => ({ link: linkResult(await findLink(link)) }))
	);

	server.registerTool(
		'get_link_qr',
		{
			title: 'Get a link QR code',
			description: 'Gets a PNG QR code of a short URL, by link ID or slug.',
			inputSchema: z.object({ link: z.string().min(1).max(100).describe('The link ID or slug.') }),
			outputSchema: z.looseObject({
				shortUrl: z.string(),
				mimeType: z.literal('image/png'),
				size: z.number()
			}),
			annotations: {
				title: 'Get a link QR code',
				readOnlyHint: true,
				destructiveHint: false,
				openWorldHint: false
			}
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
				'Gets clicks for one link by day, country, device, referrer, browser, and operating system. The range is in UTC days and defaults to the last 30 days.',
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
			outputSchema: z.looseObject({
				analytics: z.looseObject({
					linkId: z.string(),
					from: z.string(),
					to: z.string(),
					total: z.number(),
					days: z.array(z.looseObject({ day: z.string(), clicks: z.number() })),
					countries: z.array(clicks),
					devices: z.array(clicks),
					referrers: z.array(clicks),
					browsers: z.array(clicks).optional(),
					operatingSystems: z.array(clicks).optional(),
					asOf: z.string()
				})
			}),
			annotations: {
				title: 'Get link analytics',
				readOnlyHint: true,
				destructiveHint: false,
				openWorldHint: false
			}
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
			description:
				'Gets usage against the limits of the workspace this app may use, with its name: clicks recorded this calendar month (UTC), clicks not recorded after the allowance was full, active links, custom domains, days of history, and a warning for each limit at 80% or 100%.',
			inputSchema: z.object({}),
			outputSchema: z.looseObject({
				usage: z.looseObject({
					workspace: z.looseObject({ id: z.string(), name: z.string() }),
					month: z.string(),
					clicks: z.number(),
					clickLimit: z.number(),
					unrecordedClicks: z.number(),
					unrecordedSince: z.string().nullable(),
					links: z.looseObject({ used: z.number(), limit: z.number() }),
					domains: z.looseObject({ used: z.number(), limit: z.number() }),
					retentionDays: z.number(),
					warnings: z.array(
						z.looseObject({
							resource: z.enum(['clicks', 'links', 'domains']),
							level: z.union([z.literal(80), z.literal(100)])
						})
					),
					asOf: z.string()
				})
			}),
			annotations: {
				title: 'Get usage',
				readOnlyHint: true,
				destructiveHint: false,
				openWorldHint: false
			}
		},
		() => attempt(async () => ({ usage: await client.getUsage() }))
	);

	server.registerTool(
		'list_domains',
		{
			title: 'List domains',
			description:
				'Lists the domains links can use, with their status and how to connect each one. Only active domains serve links.',
			inputSchema: z.object({}),
			outputSchema: z.looseObject({
				domains: z.array(domainOutput),
				used: z.number(),
				limit: z.number()
			}),
			annotations: {
				title: 'List domains',
				readOnlyHint: true,
				destructiveHint: false,
				openWorldHint: false
			}
		},
		() =>
			attempt(async () => {
				const page = await client.listDomains();
				return { domains: page.domains.map(domainResult), used: page.used, limit: page.limit };
			})
	);

	server.registerTool(
		'export_links',
		{
			title: 'Export links',
			description:
				"Exports every link in the workspace, on and off, newest first, 50 per page by default and up to 100. Each result has the link's status and an item with the fields of import_links: send items to import_links three at a time to move links. Imported links start on; status is not copied. No analytics. Pass nextCursor for the next page.",
			inputSchema: z.object({
				limit: z.number().int().min(1).max(maxExportPageSize).optional(),
				cursor: z.string().max(500).optional().describe('nextCursor from the previous page.')
			}),
			outputSchema: z.looseObject({
				links: z.array(exportedLinkOutput),
				nextCursor: z.string().nullable()
			}),
			annotations: {
				title: 'Export links',
				readOnlyHint: true,
				destructiveHint: false,
				openWorldHint: false
			}
		},
		({ limit = exportPageSize, cursor }) =>
			attempt(async () => {
				const read = async (size: number) => {
					const page = await client.exportLinks(cursor, size);
					const value = { links: page.links.map(exportedLink), nextCursor: page.nextCursor };
					return { value, bytes: new TextEncoder().encode(JSON.stringify(value)).byteLength };
				};
				// A page over the byte cap is asked for again with half as many links. One link at
				// its longest is about 13 KB, so the loop always ends within the cap. The API makes
				// every cursor, so a cut page still continues where it ends.
				let page = await read(limit);
				while (page.bytes > mcpExportResultBytes && page.value.links.length > 1)
					page = await read(Math.floor(page.value.links.length / 2));
				return page.value;
			})
	);

	server.registerTool(
		'list_automations',
		{
			title: 'List automations',
			description:
				"Lists the workspace's automation templates (a trigger, then actions) and how many links each is on. With link, lists the templates applied to that link with their state: waiting, done, failed, or skipped.",
			inputSchema: z.object({
				link: z.string().min(1).max(100).optional().describe('A link ID or slug.')
			}),
			outputSchema: z.looseObject({
				automations: z.array(z.union([automationOutput, linkAutomationOutput])),
				used: z.number().optional(),
				limit: z.number().optional(),
				link: z.looseObject({ id: z.string(), shortUrl: z.string() }).optional()
			}),
			annotations: {
				title: 'List automations',
				readOnlyHint: true,
				destructiveHint: false,
				openWorldHint: false
			}
		},
		({ link }) =>
			attempt(async () => {
				if (link === undefined) {
					const page = await client.listAutomations();
					return { automations: page.automations, used: page.used, limit: page.limit };
				}
				const found = await findLink(link);
				const page = await client.listLinkAutomations(found.id);
				return {
					link: { id: found.id, shortUrl: found.shortUrl },
					automations: page.automations
				};
			})
	);

	server.registerTool(
		'create_link',
		{
			title: 'Create a link',
			description:
				'Creates a public short link to a destination URL. Optional utm values are added to the destination; optional iPhone and Android destinations, such as app links, receive visitors on those devices. The same request repeated within five minutes returns the first link.',
			inputSchema: createLinkInput,
			outputSchema: z.looseObject({ link: linkOutput, replayed: z.boolean() }),
			annotations: {
				title: 'Create a link',
				readOnlyHint: false,
				// The Claude directory asks for this hint on every tool that changes data.
				destructiveHint: true,
				idempotentHint: true,
				openWorldHint: true
			}
		},
		(input) =>
			attempt(async () => {
				const { domain } = input;
				const fields = createFields(input);
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
		'import_links',
		{
			title: 'Import links',
			description: `Creates up to ${mcpImportItemsPerCall} short links in one call; each item takes the fields of create_link. First call it with dryRun true and show the person the result: a dry run checks every item and creates nothing. Then call it again with dryRun false and the same items. Each item is created or fails on its own. The same call repeated within five minutes returns the first results and creates nothing twice. For more links, send several calls of up to ${mcpImportItemsPerCall} items.`,
			inputSchema: z.object({
				dryRun: z
					.boolean()
					.describe(
						'true checks the items and creates nothing; use it first. false creates the links.'
					),
				items: z.array(createLinkInput).min(1).max(mcpImportItemsPerCall)
			}),
			outputSchema: importOutput,
			annotations: {
				title: 'Import links',
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: true,
				openWorldHint: true
			}
		},
		({ dryRun, items }) =>
			attempt(
				async () => {
					const hostnames = items.map((item) =>
						item.domain === undefined ? undefined : hostnameOf(item.domain)
					);
					const domains = hostnames.some((hostname) => hostname !== undefined)
						? (await client.listDomains()).domains
						: [];
					const requested = items.map((item, index) => {
						const hostname = hostnames[index];
						const fields = createFields(item);
						return hostname === undefined
							? fields
							: {
									...fields,
									domainId: activeDomain(domains, hostname, `items.${index}.domain`).id
								};
					});
					const window = Math.floor(now() / 300_000);
					// The API gives item n the key `${key}:${n}`, so a retry replays each item.
					const key = `mcp-import-${await sha256(JSON.stringify([grantKey, window, requested]))}`;
					return importResult(
						await client.importLinks({ dryRun, items: requested, idempotencyKey: key })
					);
				},
				async (value) => [{ type: 'text', text: importSummary(value) }]
			)
	);

	server.registerTool(
		'update_link',
		{
			title: 'Update a link',
			description:
				'Changes the destination, title, UTM parameters, or iPhone and Android destinations of a link. The short URL stays the same.',
			inputSchema: z.object({
				link: z.string().min(1).max(100).describe('The link ID or slug.'),
				destination: z.string().min(1).max(4096).optional(),
				title: z.string().max(200).nullable().optional().describe('null removes the title.'),
				iosDestination: deviceDestination('iPhone', ' null removes it.').nullable().optional(),
				androidDestination: deviceDestination('Android', ' null removes it.').nullable().optional(),
				utm: utmInput
					.optional()
					.describe(
						'Set on the new destination, or on the current one when destination is absent. An empty value removes the parameter.'
					)
			}),
			outputSchema: z.looseObject({ link: linkOutput }),
			annotations: {
				title: 'Update a link',
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: true,
				openWorldHint: true
			}
		},
		({ link, destination, title, iosDestination, androidDestination, utm }) =>
			attempt(async () => {
				const found = await findLink(link);
				const target = utm ? withUtm(destination ?? found.destination, utm) : destination;
				return {
					link: linkResult(
						await client.updateLink(found.id, {
							destination: target,
							title,
							iosDestination,
							androidDestination
						})
					)
				};
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
				outputSchema: z.looseObject({ link: linkOutput }),
				annotations: {
					title: enabled ? 'Turn on a link' : 'Turn off a link',
					readOnlyHint: false,
					destructiveHint: true,
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

	server.registerTool(
		'apply_automation',
		{
			title: 'Apply an automation',
			description:
				'Applies an automation template to links. Each applied template runs once when its trigger is met; applying again re-arms one that already ran. A link keeps up to 5. Templates are created by the workspace owner in the Flared app.',
			inputSchema: z.object({
				automationId,
				linkIds: z
					.array(z.string().min(1).max(maxAutomationIdLength))
					.min(1)
					.max(maxApplyLinks)
					.describe('Link IDs from list_links or get_link.'),
				endsAt: z
					.string()
					.max(40)
					.optional()
					.describe(
						'For an end date template only, and required by it: when it runs, in ISO 8601 with an offset, such as 2026-11-01T09:00:00Z.'
					)
			}),
			outputSchema: z.looseObject({
				results: z.array(
					z.looseObject({
						linkId: z.string(),
						status: z.enum(['applied', 'unchanged', 'failed']),
						error: z.looseObject({ code: z.string(), message: z.string() }).optional()
					})
				)
			}),
			annotations: {
				title: 'Apply an automation',
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: true,
				openWorldHint: true
			}
		},
		({ automationId, linkIds, endsAt }) =>
			attempt(async () => {
				const { results } = await client.applyAutomation(automationId, linkIds, endsAt);
				return {
					results: results.map(({ linkId, status, error }) => ({
						linkId,
						status,
						...(error ? { error: { code: error.code, message: error.message } } : {})
					}))
				};
			})
	);

	server.registerTool(
		'remove_automation',
		{
			title: 'Remove an automation',
			description:
				'Takes an automation template off a link, by link ID or slug, so it does not run there. The template stays in the workspace.',
			inputSchema: z.object({
				automationId,
				link: z.string().min(1).max(100).describe('The link ID or slug.')
			}),
			outputSchema: z.looseObject({ removed: z.boolean() }),
			annotations: {
				title: 'Remove an automation',
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: true,
				openWorldHint: false
			}
		},
		({ automationId, link }) =>
			attempt(async () => {
				const found = await findLink(link);
				try {
					await client.removeLinkAutomation(found.id, automationId);
					return { removed: true };
				} catch (error) {
					// Already off the link: the call is done either way.
					if (error instanceof FlaredApiError && error.code === 'NOT_FOUND')
						return { removed: false };
					throw error;
				}
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
				? await resolveTenant(options.identity, {
						userId: stored.userId,
						tenantId: stored.tenantId
					})
				: null;
		if (!stored || tenant?.status !== 'active')
			return jsonRpcError(401, 'The access token is not valid.', {
				'www-authenticate': challenge(', error="invalid_token"')
			});
		// The token stays valid, so the app can work again after a reinstatement.
		if (tenant.suspension) return jsonRpcError(403, 'Flared suspended this workspace.');
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

		// Only the tools this endpoint serves; a client can name anything.
		const tool = calledTool(body);
		if (tool && tool in toolScopes)
			await recordProductEvent(options.events, {
				type: 'mcp_tool_called',
				userId: stored.userId,
				tenantId: stored.tenantId,
				clientId: stored.clientId,
				tool
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
