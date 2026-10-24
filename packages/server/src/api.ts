// SPDX-License-Identifier: AGPL-3.0-only
// The product API at /v1. Applications supply the principal: a dashboard session or an API
// token. The tenant always comes from a stored membership: the session's active workspace, or
// the workspace a token or connected app is bound to.
import type { D1Database } from '@cloudflare/workers-types/index.ts';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import type { ErrorCode } from '@flared/contracts/errors';
import {
	AnalyticsRangeError,
	AnalyticsUnavailableError,
	getExportDimensions,
	getExportTotals,
	getLinkAnalytics,
	getRecentClicks,
	getUsage
} from './analytics';
import type { AnalyticsShards } from './shards';
import type { LinkPasswords } from './link-passwords';
import { removePreviewImage, setPreviewImage, type PreviewImageStore } from './preview-images';
import {
	ImportRequestError,
	LinkInputError,
	maxDestinationLength,
	maxPreviewImageBytes,
	parseCreateLink,
	parseIdempotencyKey,
	parseImportRequest,
	parseUpdateLink,
	previewImageTypes
} from '@flared/contracts/links';
import {
	isTokenScope,
	parseCreateToken,
	roleScopes,
	type ApiIdentity,
	type ApiTokenIdentity,
	type ApiTokenPage,
	type TokenScope
} from '@flared/contracts/tokens';
import { openApiDocument } from '@flared/contracts/openapi';
import { parseAddDomain } from '@flared/contracts/domains';
import { exportLinkPageSize } from '@flared/contracts/export';
import {
	parseWorkspaceName,
	parseSelectWorkspace,
	workspaceHeader,
	type Workspace,
	type WorkspaceList,
	type WorkspaceSummary
} from '@flared/contracts/workspace';
import {
	listWorkspaces,
	readTenantName,
	renameTenant,
	setActiveWorkspace,
	type MembershipRole
} from '@flared/data/tenancy';
import {
	inviteLifetimeDays,
	parseInvite,
	parseInviteToken,
	parseLinkInvite,
	parseTransfer,
	transferLifetimeDays,
	type AcceptedInvite,
	type CreatedInvite,
	type InvitePreview,
	type MemberPage,
	type OwnershipOffer,
	type PasswordResetLink,
	type WorkspaceInvite
} from '@flared/contracts/members';
import {
	acceptInvite,
	cancelInvite,
	cancelTransfer,
	removeMember,
	countInviteEmail,
	createInvite,
	createPasswordReset,
	passwordResetLifetimeMs,
	listInvites,
	listMembers,
	offerTransfer,
	readInvite,
	readInviteEmail,
	readMemberCount,
	readTransfer,
	transferOwnership,
	type TransferInput
} from '@flared/data/members';
import { defaultQrSize, maxQrSize, minQrSize, qrPng, qrSvg } from '@flared/client/qr';
import { knownAssistant, type ConnectedApp, type ConnectedAppPage } from '@flared/contracts/oauth';
import { accountDeletionRunning } from '@flared/data/deletions';
import { countApiCall, deleteGrant, findAccessToken, listGrants } from '@flared/data/oauth';
import { accessTokenPrefix, hashOAuthToken } from './oauth/provider';
import {
	countCreationAttempt,
	releaseCreationWindow,
	reserveCreationWindow
} from '@flared/data/links';
import { iconHostname } from '@flared/contracts/icons';
import {
	newWebhookEventId,
	parseCreateHook,
	parseCreateWebhook,
	parseUpdateWebhook,
	subscribableWebhookEvents,
	type CreatedHook,
	type CreatedWebhookEndpoint,
	type Hook,
	type WebhookDelivery,
	type WebhookDeliveryPage,
	type WebhookEndpoint,
	type WebhookEndpointPage
} from '@flared/contracts/webhooks';
import {
	createWebhookEndpoint,
	deleteHooks,
	deleteWebhookEndpoint,
	insertTestEvent,
	listEndpointDeliveries,
	listWebhookEndpoints,
	readWebhookEndpoint,
	rotateWebhookSecret,
	subscribeHook,
	updateWebhookEndpoint,
	type HookMatch,
	type WebhookDeliveryRow,
	type WebhookEndpointRow
} from '@flared/data/webhooks';
import { deliverWebhookEvent, deliverWebhooks, type WebhookTransport } from './webhooks/deliver';
import {
	automationEndsAt,
	newAutomationId,
	parseApplyAutomation,
	parseApplyAutomationLinks,
	parseCreateAutomation,
	parseUpdateAutomation,
	type ApplyAutomationLinkResult,
	type ApplyAutomationLinksResult,
	type ApplyLinkAutomationResult,
	type AutomationAction,
	type AutomationFeatures,
	type AutomationRunPage,
	type LinkAutomationPage
} from '@flared/contracts/automations';
import {
	createAutomation,
	deleteAutomation,
	listAutomationRuns,
	listAutomations,
	listLinkAutomations,
	readAutomation,
	removeLinkAutomation,
	updateAutomation
} from '@flared/data/automations';
import { applyToLinks, type LinkApplyOutcome, type LinkApplyResult } from './automations/apply';
import {
	automationPage,
	automationSummary,
	linkAutomationSummary,
	runSummary
} from './automations/summaries';
import { endpointSecret, keyId } from './webhooks/signing';
import { iconHeaders, resolveIcon, type Fetcher, type IconStore } from './icons';
import {
	TokenLimitError,
	createToken,
	listTokens,
	revokeToken,
	verifyToken,
	type ApiTokenAuth
} from './auth/api-tokens';
import { freshUntil } from './auth/session';
import { noteLimitUsage } from './notices';
import {
	hashInviteToken,
	inviteEmail,
	invitesPerDay,
	newInviteToken,
	transferEmail,
	type InviteSettings,
	type LinkInviteSettings
} from './members';
import { resolveTenant } from './tenancy';
import { parseImportItems, previewImport, runImport } from './imports';
import { linkChannel, recordProductEvent, type ProductEvents } from './events';
import {
	addDomain,
	checkDomain,
	getDomain,
	listDomainPage,
	removeDomain,
	type DomainSettings
} from './domains';
import { changePage, createPage, getPage, listPages, removePage, type PageSettings } from './pages';
import { parseCreatePage, parseUpdatePage } from '@flared/contracts/pages';
import {
	ApiError,
	changeLink,
	createLink,
	errorBody,
	exportLinks,
	getLink,
	listLinks,
	statusOf,
	type ApiResult
} from './links';

export type ApiPrincipal =
	// A dashboard session holds every scope. signedInAt is an ISO time.
	| { kind: 'session'; userId: string; sessionId: string; signedInAt: string }
	| {
			kind: 'token';
			userId: string;
			tenantId: string;
			scopes: readonly TokenScope[];
			token: ApiTokenIdentity;
	  }
	// An app connected through OAuth: an assistant calling the MCP endpoint in process (mcp), or
	// a client the operator registered calling the REST API (api).
	| {
			kind: 'oauth';
			userId: string;
			tenantId: string;
			scopes: readonly TokenScope[];
			clientId: string;
			channel: 'mcp' | 'api';
	  };

export type ApiAuthentication =
	ApiPrincipal | { kind: 'rate_limited'; retryAfterSeconds: number } | null;

export interface ApiDependencies {
	identity: D1Database;
	routing: D1Database;
	// Analytics shards by ID. Without them, analytics routes answer 503 and lists carry no clicks.
	analytics?: AnalyticsShards;
	// The exact application origin from deployment configuration.
	appOrigin: string;
	// Returns the request's principal, or null when it carries no valid credential.
	authenticate(request: Request): Promise<ApiAuthentication>;
	// The WWW-Authenticate value of a 401 answer, such as the bearer API's pointer to its RFC 9728
	// metadata. Without it, a 401 has no challenge.
	challenge?: string;
	// Creates API tokens. Without it, token creation answers 503.
	tokenAuth?: ApiTokenAuth;
	// The public URL of this API from deployment configuration, such as
	// https://api.flared.page/v1. With it, GET /v1/openapi.json serves the API description.
	publicApiUrl?: string;
	// Custom domains. Without a provider, domains are listed but cannot be added.
	domains?: DomainSettings;
	now?: () => number;
	creationsPerMinute?: number;
	// Items in one POST /v1/links/import. The default keeps a full request within the 50 D1
	// queries a Workers Free invocation may run, counting each batch statement as one query:
	// about 7 statements per request (authentication, workspace, import window, limit notice)
	// plus up to 12 per item (domain lookup, the 9-statement create batch, and the key check and
	// stored-result read of a replay), and the 7 of a webhook delivery in the background, which
	// counts against the same invocation. Measured with 3 items over MCP: 40 created plus 7 for
	// the delivery, 45 replayed (no delivery). On Workers Paid (1,000) a deployment can raise it.
	// Automation applies stay far below: one link or 100 links with a clicks template take 7
	// statements, and the MCP apply_automation call 10; an apply stages no webhook event.
	importItemsPerRequest?: number;
	// Links imported per workspace in each UTC hour, apart from creationsPerMinute.
	importsPerHour?: number;
	// A single-workspace installation's tenant. Any other tenant is refused, in addition to the
	// database's one-tenant guard.
	fixedTenantId?: string;
	// Site icons for the dashboard. Without a store, every icon answers 404 and the dashboard
	// shows a letter tile.
	icons?: IconSettings;
	// Invites by email. Without them, the invite routes answer 404; members are still listed,
	// and an offer of the workspace goes out without an email.
	invites?: InviteSettings;
	// Creates a workspace that the user owns. A single-workspace installation has none, and
	// POST /v1/workspaces answers 404.
	createWorkspace?: (input: {
		userId: string;
		name: string;
		now: number;
	}) => Promise<WorkspaceCreation>;
	// Hands the workspace to the member who accepts the owner's offer, with the edition's own
	// rules. Without it, the core transfer runs with none.
	transferOwnership?: (input: TransferInput) => Promise<OwnershipTransfer>;
	// The edition's product analytics. Without it, no event is recorded.
	events?: ProductEvents;
	// Webhooks. Without them, the webhook routes answer 404 and changes only stage events.
	webhooks?: WebhookSettings;
	// The installation's link password key. Without it, a password cannot be set, and a link
	// that has one does not open.
	linkPasswords?: LinkPasswords;
	// Where uploaded preview images are kept. Without it, an image upload answers 503; the
	// preview texts still work.
	previewImages?: PreviewImageStore;
	// Automations, with what this installation offers: without email, the email action is
	// refused; without destination checks, the destination-down trigger is; without messages
	// (which needs webhooks.transports), post_message is. Without them, the automation routes
	// answer 404.
	automations?: AutomationFeatures;
	// Where pages show. Without a host, a page shows only at the root of a workspace domain.
	pages?: PageSettings;
}

export interface WebhookSettings {
	// The deployment secret that endpoint secrets are derived from. A new value changes every
	// endpoint secret; each endpoint then needs a rotation.
	secret: string;
	fetch?: typeof fetch;
	// Runs work after the response, such as ExecutionContext.waitUntil. Without it, a change's
	// event waits for the scheduled job.
	background?: (task: Promise<unknown>) => void;
	// Deliveries sent after one change. Each adds a fetch to the request's invocation; the
	// default keeps an import within the D1 budget above.
	requestDeliveries?: number;
	// Test events per workspace and hour.
	testsPerHour?: number;
	// The edition's senders for endpoints of other transports than http, by transport name. The
	// webhook routes manage only http endpoints; the edition manages its own.
	transports?: Readonly<Record<string, WebhookTransport>>;
	// REST hooks, which POST /v1/hooks subscribes. Their sender (hookSender from
	// ./webhooks/hooks) goes in transports under 'resthook' with the same hosts. Without them,
	// the hook routes answer 404.
	hooks?: { allowedHosts: readonly string[] };
}

// A client subscribes a hook again after 7 days; a hook gets events for 14 days, so a late
// renewal misses none.
const hookRenewMs = 7 * 86400000;
const hookLifetimeMs = 14 * 86400000;

// The limit that each plan-limit error stands for, for the limit_reached event.
const limitOfError: Partial<Record<ErrorCode, 'links' | 'members' | 'domains'>> = {
	PLAN_LIMIT_REACHED: 'links',
	MEMBER_LIMIT_REACHED: 'members',
	DOMAIN_LIMIT_REACHED: 'domains'
};

// invalid: no open offer names the member. limit: the member cannot own this workspace now, for
// the reason in message.
export type OwnershipTransfer =
	{ status: 'transferred' } | { status: 'invalid' } | { status: 'limit'; message: string };

// limit: the person cannot create another workspace now, for the reason in message.
// unavailable: the installation cannot take a new workspace at the moment.
export type WorkspaceCreation =
	| { status: 'created'; tenantId: string }
	| { status: 'limit'; message: string }
	| { status: 'unavailable' };

export interface IconSettings {
	store: IconStore;
	fetch?: Fetcher;
	// Fetches from sites for each workspace and minute; stored icons are always served.
	fetchesPerMinute?: number;
}

// REST API calls per OAuth grant and minute, as for an API token.
export const oauthApiCallsPerMinute = 60;

// An OAuth access token bound to the REST API resource. The API checks on every request that
// the person still belongs to the grant's workspace.
async function oauthPrincipal(
	identity: D1Database,
	token: string,
	resource: string,
	now: number
): Promise<ApiAuthentication> {
	if (token.length > 128) return null;
	const stored = await findAccessToken(
		identity,
		await hashOAuthToken(token.slice(accessTokenPrefix.length), 'access_token'),
		now
	);
	// The audience check: a token for the MCP endpoint does not work here.
	if (!stored || !stored.resources.includes(resource)) return null;
	const grantKey = `${stored.clientId}\u0000${stored.userId}\u0000${stored.tenantId}`;
	const budget = await countApiCall(identity, grantKey, now, oauthApiCallsPerMinute);
	if (!budget.allowed) return { kind: 'rate_limited', retryAfterSeconds: budget.retryAfterSeconds };
	return {
		kind: 'oauth',
		userId: stored.userId,
		tenantId: stored.tenantId,
		scopes: stored.scopes.filter(isTokenScope),
		clientId: stored.clientId,
		channel: 'api'
	};
}

// Reads "Authorization: Bearer <token>" only. Applications that accept tokens use this as
// their authenticate function; cookies on the same request are ignored. With oauth, OAuth
// access tokens bound to that REST API resource work too.
export async function authenticateBearer(
	tokenAuth: ApiTokenAuth,
	identity: D1Database,
	request: Request,
	oauth?: { resource: string; now?: () => number }
): Promise<ApiAuthentication> {
	const match = /^Bearer +(\S+)$/i.exec(request.headers.get('authorization') ?? '');
	if (!match) return null;
	if (match[1].startsWith(accessTokenPrefix))
		return oauth
			? oauthPrincipal(identity, match[1], oauth.resource, (oauth.now ?? Date.now)())
			: null;
	const result = await verifyToken(tokenAuth, identity, match[1]);
	if (result.status === 'valid') return { kind: 'token', ...result.principal };
	if (result.status === 'rate_limited')
		return { kind: 'rate_limited', retryAfterSeconds: result.retryAfterSeconds };
	return null;
}

const maxBodyBytes = 8192;
// A page with its full list of blocks.
const maxPageBodyBytes = 65536;
// The default of ApiDependencies.importItemsPerRequest. The MCP import_links tool caps its items
// at it, because the MCP endpoint does not see a deployment's API options.
export const defaultImportItemsPerRequest = 3;
// Three destinations at their longest, the other fields, and JSON punctuation.
const importItemBytes = 3 * maxDestinationLength + 1024;
const hourMs = 3_600_000;
// The workspace list and the switch work whatever state the active workspace is in, so a
// person can always move to another workspace.
// An invite is accepted from any workspace, or from none.
const workspacePaths = new Set([
	'/v1/workspaces',
	'/v1/workspaces/active',
	'/v1/invites/lookup',
	'/v1/invites/accept'
]);
const dayMs = 86_400_000;
// The previous secret keeps signing for this long after a rotation.
const secretGraceMs = dayMs;

type Variables = {
	requestId: string;
	tenantId: string;
	role: MembershipRole;
	principal: ApiPrincipal;
};
type ApiContext = Context<{ Variables: Variables }>;

function respond(result: ApiResult, extra: Record<string, string> = {}): Response {
	const headers = new Headers({
		'content-type': 'application/json',
		'cache-control': 'no-store',
		...extra
	});
	if (result.replayed) headers.set('idempotent-replayed', 'true');
	return new Response(result.body, { status: result.status, headers });
}

function failure(
	code: ErrorCode,
	message: string,
	requestId: string,
	headers: Record<string, string> = {},
	field?: string
) {
	return respond(
		{ status: statusOf(code), body: errorBody(code, message, requestId, field) },
		headers
	);
}

async function readJson(request: Request, limit = maxBodyBytes): Promise<unknown> {
	if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))
		throw new ApiError('UNSUPPORTED_MEDIA_TYPE', 'Send the body as application/json.');
	const declared = Number(request.headers.get('content-length') ?? '0');
	if (declared > limit) throw new ApiError('PAYLOAD_TOO_LARGE', 'The body is too large.');
	const bytes = await request.arrayBuffer();
	if (bytes.byteLength > limit) throw new ApiError('PAYLOAD_TOO_LARGE', 'The body is too large.');
	try {
		return JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		throw new ApiError('INVALID_INPUT', 'Send valid JSON.');
	}
}

// The raw body of an image upload, read up to the size limit. The handler checks the bytes.
async function readImage(request: Request): Promise<Uint8Array> {
	const type = request.headers.get('content-type')?.toLowerCase().split(';')[0]?.trim() ?? '';
	if (!(Object.values(previewImageTypes) as string[]).includes(type))
		throw new ApiError('UNSUPPORTED_MEDIA_TYPE', 'Upload a PNG, JPEG, or WebP image.');
	const tooLarge = () => new ApiError('PAYLOAD_TOO_LARGE', 'Use an image of at most 5 MB.');
	if (Number(request.headers.get('content-length') ?? '0') > maxPreviewImageBytes) throw tooLarge();
	const reader = request.body?.getReader();
	if (!reader) throw new ApiError('INVALID_INPUT', 'Upload an image.');
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > maxPreviewImageBytes) {
			await reader.cancel();
			throw tooLarge();
		}
		chunks.push(value);
	}
	if (size === 0) throw new ApiError('INVALID_INPUT', 'Upload an image.');
	const body = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return body;
}

function pageSize(value: string | undefined): number {
	if (value === undefined) return 50;
	const size = Number(value);
	if (!Number.isInteger(size) || size < 1 || size > 100)
		throw new ApiError('INVALID_INPUT', 'Use a limit from 1 to 100.');
	return size;
}

function exportPageSize(value: string | undefined): number {
	if (value === undefined) return exportLinkPageSize;
	const size = Number(value);
	if (!Number.isInteger(size) || size < 1 || size > exportLinkPageSize)
		throw new ApiError('INVALID_INPUT', `Use a limit from 1 to ${exportLinkPageSize}.`);
	return size;
}

function search(value: string | undefined): string | null {
	if (value === undefined || !value.trim()) return null;
	if (value.length > 100)
		throw new ApiError('INVALID_INPUT', 'Use a search of at most 100 characters.');
	return value.trim();
}

// A domain ID from GET /v1/domains. Another workspace's ID matches none of this workspace's links.
function domainFilter(value: string | undefined): string | null {
	if (value === undefined || value === '') return null;
	if (value.length > 64)
		throw new ApiError('INVALID_INPUT', 'Use a domain ID from GET /v1/domains.');
	return value;
}

export function createApi(dependencies: ApiDependencies): Hono<{ Variables: Variables }> {
	const { identity, routing, appOrigin } = dependencies;
	const now = dependencies.now ?? Date.now;
	const creationsPerMinute = dependencies.creationsPerMinute ?? 60;
	const importItemsPerRequest = dependencies.importItemsPerRequest ?? defaultImportItemsPerRequest;
	const importsPerHour = dependencies.importsPerHour ?? 2000;
	const domainSettings: DomainSettings = dependencies.domains ?? { reservedHostnames: [] };
	// A webhook or a destination check may not call the installation itself.
	const webhookReserved = [
		...domainSettings.reservedHostnames,
		new URL(appOrigin).hostname,
		...(dependencies.publicApiUrl ? [new URL(dependencies.publicApiUrl).hostname] : [])
	];
	let currentKeyId: Promise<string> | null = null;
	const app = new Hono<{ Variables: Variables }>().basePath('/v1');

	// A limit refusal is a product event; the refusal itself does not depend on it.
	async function recordLimit(
		context: ApiContext,
		limit: 'links' | 'members' | 'domains'
	): Promise<void> {
		const principal = context.get('principal');
		const tenantId = context.get('tenantId');
		if (principal && tenantId)
			await recordProductEvent(dependencies.events, {
				type: 'limit_reached',
				userId: principal.userId,
				tenantId,
				limit
			});
	}

	function webhookSettings(): WebhookSettings {
		if (!dependencies.webhooks) throw new ApiError('NOT_FOUND', 'Route not found.');
		return dependencies.webhooks;
	}

	function hookSettings(): NonNullable<WebhookSettings['hooks']> {
		const settings = webhookSettings().hooks;
		if (!settings) throw new ApiError('NOT_FOUND', 'Route not found.');
		return settings;
	}

	// Deletes the hooks made with access that has just ended. The access is already gone, so a
	// failure is logged, and each hook stops at its expiry.
	async function endHooks(tenantId: string, match: HookMatch, requestId: string): Promise<void> {
		try {
			await deleteHooks(routing, tenantId, match);
		} catch {
			console.error(JSON.stringify({ event: 'hooks_end_failed', requestId }));
		}
	}

	function webhookKeyId(settings: WebhookSettings): Promise<string> {
		currentKeyId ??= keyId(settings.secret);
		return currentKeyId;
	}

	async function endpointBody(
		settings: WebhookSettings,
		row: WebhookEndpointRow
	): Promise<WebhookEndpoint> {
		return endpointSummary(row, row.keyId !== (await webhookKeyId(settings)));
	}

	// After a change that staged an event, its workspace's new deliveries go out after the
	// response. A failure leaves them for the scheduled job.
	function deliverLater(tenantId: string, requestId: string): void {
		const settings = dependencies.webhooks;
		if (!settings?.background) return;
		settings.background(
			deliverWebhooks(routing, tenantId, {
				secret: settings.secret,
				reservedHostnames: webhookReserved,
				fetch: settings.fetch,
				transports: settings.transports,
				now,
				limit: settings.requestDeliveries
			}).catch(() => console.error(JSON.stringify({ event: 'webhook_dispatch_failed', requestId })))
		);
	}

	app.onError(async (error, context) => {
		const requestId = context.get('requestId') ?? crypto.randomUUID();
		const limit = error instanceof ApiError ? limitOfError[error.code] : undefined;
		if (limit) await recordLimit(context, limit);
		if (error instanceof ApiError)
			return failure(error.code, error.message, requestId, {
				...(error.retryAfterSeconds ? { 'retry-after': String(error.retryAfterSeconds) } : {}),
				...(error.code === 'UNAUTHENTICATED' && dependencies.challenge
					? { 'www-authenticate': dependencies.challenge }
					: {})
			});
		if (error instanceof LinkInputError)
			return failure('INVALID_INPUT', error.message, requestId, {}, error.field);
		if (error instanceof AnalyticsRangeError)
			return failure('INVALID_INPUT', error.message, requestId);
		if (error instanceof AnalyticsUnavailableError) {
			console.error(JSON.stringify({ event: 'analytics_unavailable', requestId }));
			return failure('SERVICE_UNAVAILABLE', 'Analytics are not available. Try again.', requestId);
		}
		console.error(JSON.stringify({ event: 'api_failed', requestId }));
		return failure('SERVICE_UNAVAILABLE', 'The service is not available. Try again.', requestId);
	});
	app.notFound((context) =>
		failure('NOT_FOUND', 'Route not found.', context.get('requestId') ?? crypto.randomUUID())
	);

	// Public and registered before authentication, so it needs no credential.
	const { publicApiUrl } = dependencies;
	if (publicApiUrl)
		app.get('/openapi.json', () =>
			Response.json(openApiDocument(publicApiUrl), {
				headers: { 'cache-control': 'public, max-age=300' }
			})
		);

	app.use('*', async (context, next) => {
		context.set('requestId', crypto.randomUUID());
		const principal = await dependencies.authenticate(context.req.raw);
		if (!principal) throw new ApiError('UNAUTHENTICATED', 'Sign in to continue.');
		if (principal.kind === 'rate_limited')
			throw new ApiError(
				'RATE_LIMITED',
				'Too many requests with this token. Try again soon.',
				principal.retryAfterSeconds
			);
		const method = context.req.method;
		// Cookie-authenticated mutations need the exact application origin. A token is no ambient
		// credential, so token requests need none.
		if (
			principal.kind === 'session' &&
			method !== 'GET' &&
			method !== 'HEAD' &&
			context.req.header('origin') !== appOrigin
		)
			throw new ApiError('ORIGIN_REJECTED', 'This request must come from the Flared app.');
		if (workspacePaths.has(context.req.path)) {
			context.set('principal', principal);
			return next();
		}
		// A token or connected app acts only in its own workspace, and only while its user still
		// belongs to it.
		const tenant = await resolveTenant(
			identity,
			principal.kind === 'session'
				? { userId: principal.userId, sessionId: principal.sessionId }
				: { userId: principal.userId, tenantId: principal.tenantId }
		);
		if (principal.kind !== 'session' && tenant.status !== 'active')
			throw new ApiError('UNAUTHENTICATED', 'Sign in to continue.');
		if (
			tenant.status === 'none' ||
			(dependencies.fixedTenantId !== undefined && tenant.tenantId !== dependencies.fixedTenantId)
		)
			throw new ApiError('NO_WORKSPACE', 'Your account has no workspace.');
		// A dashboard tab names the workspace it shows. After a switch in another tab, its changes
		// would land in the other workspace, so they are refused.
		const shown = context.req.header(workspaceHeader);
		if (
			principal.kind === 'session' &&
			method !== 'GET' &&
			method !== 'HEAD' &&
			shown !== undefined &&
			shown !== tenant.tenantId
		)
			throw new ApiError(
				'WORKSPACE_CHANGED',
				'You switched workspaces in another tab. Reload the page to continue.'
			);
		if (tenant.status === 'pending')
			throw new ApiError(
				'WORKSPACE_PENDING',
				'Your workspace is still being set up. Try again.',
				30
			);
		if (tenant.status === 'deleting')
			throw new ApiError('ACCOUNT_DELETING', 'This account is being deleted.');
		if (tenant.suspension && !allowedWhileSuspended(principal, method, context.req.path))
			throw new ApiError(
				'WORKSPACE_SUSPENDED',
				'Flared suspended this workspace. You can still export your data.'
			);
		context.set('tenantId', tenant.tenantId);
		context.set('role', tenant.role);
		context.set('principal', principal);
		await next();
	});

	app.post('/links', requireScope('links:write'), async (context) => {
		const { requestId, tenantId } = context.var;
		const key = parseIdempotencyKey(context.req.header('idempotency-key') ?? null);
		if (!key)
			throw new ApiError(
				'IDEMPOTENCY_KEY_REQUIRED',
				'Send an Idempotency-Key header of 1 to 255 printable characters.'
			);
		const time = now();
		const allowance = await countCreationAttempt(routing, tenantId, time, creationsPerMinute);
		if (!allowance.allowed)
			throw new ApiError(
				'RATE_LIMITED',
				'Too many links created. Try again soon.',
				allowance.retryAfterSeconds
			);
		const input = parseCreateLink(await readJson(context.req.raw));
		const result = await createLink(routing, {
			tenantId,
			key,
			input,
			requestId,
			now: time,
			passwords: dependencies.linkPasswords
		});
		if (result.status === 201 && !result.replayed) {
			await noteLimitUsage(identity, routing, tenantId, time);
			const { principal } = context.var;
			await recordProductEvent(dependencies.events, {
				type: 'link_created',
				userId: principal.userId,
				tenantId,
				channel: linkChannel(principal, context.req.header('user-agent') ?? null)
			});
		}
		if (result.status === 403 && !result.replayed) await recordLimit(context, 'links');
		if (result.status === 201 && !result.replayed && result.eventStaged)
			deliverLater(tenantId, requestId);
		return respond(result);
	});

	app.post('/links/import', requireScope('links:write'), async (context) => {
		const { requestId, tenantId, principal } = context.var;
		const key = parseIdempotencyKey(context.req.header('idempotency-key') ?? null);
		if (!key)
			throw new ApiError(
				'IDEMPOTENCY_KEY_REQUIRED',
				'Send an Idempotency-Key header of 1 to 255 printable characters.'
			);
		const body = await readJson(context.req.raw, importItemsPerRequest * importItemBytes + 1024);
		let request;
		try {
			request = parseImportRequest(body, importItemsPerRequest);
		} catch (error) {
			if (error instanceof ImportRequestError)
				return failure(error.code, error.message, requestId, {}, error.field);
			throw error;
		}
		const items = parseImportItems(request.items);
		if (request.dryRun) {
			const preview = await previewImport(routing, tenantId, items, {
				passwords: dependencies.linkPasswords !== undefined
			});
			return respond({ status: 200, body: JSON.stringify(preview) });
		}
		const time = now();
		const valid = items.filter((item) => item.ok).length;
		const windowKey = `${tenantId}:imports`;
		// The whole request must fit the hour's window before anything is created. The part that
		// creates nothing, such as failed or replayed items, is given back afterwards.
		const allowance =
			valid > 0
				? await reserveCreationWindow(routing, windowKey, time, hourMs, valid, importsPerHour)
				: null;
		if (allowance && !allowance.allowed)
			throw new ApiError(
				'RATE_LIMITED',
				'Too many links imported this hour. Try again later.',
				allowance.retryAfterSeconds
			);
		const outcome = await runImport(routing, {
			tenantId,
			key,
			items,
			requestId,
			now: time,
			passwords: dependencies.linkPasswords
		});
		if (allowance && valid > outcome.created)
			await releaseCreationWindow(
				routing,
				windowKey,
				allowance.windowStart,
				valid - outcome.created
			);
		if (outcome.created > 0) {
			await noteLimitUsage(identity, routing, tenantId, time);
			const channel = linkChannel(principal, context.req.header('user-agent') ?? null);
			for (let count = 0; count < outcome.created; count += 1)
				await recordProductEvent(dependencies.events, {
					type: 'link_created',
					userId: principal.userId,
					tenantId,
					channel
				});
		}
		if (outcome.limitReached) await recordLimit(context, 'links');
		if (outcome.staged > 0) deliverLater(tenantId, requestId);
		return respond({ status: 200, body: JSON.stringify(outcome.result) });
	});
	// Before GET and PATCH /links/:id, so that other methods here answer 405 and not 404.
	app.all('/links/import', (context) => methodNotAllowed(context, 'POST'));

	app.get('/links', requireScope('links:read'), async (context) => {
		const { tenantId } = context.var;
		const page = await listLinks(
			routing,
			tenantId,
			{
				limit: pageSize(context.req.query('limit')),
				cursor: context.req.query('cursor') ?? null,
				search: search(context.req.query('q')),
				domainId: domainFilter(context.req.query('domain'))
			},
			(linkIds) => getRecentClicks(identity, dependencies.analytics, tenantId, linkIds, now())
		);
		return respond({ status: 200, body: JSON.stringify(page) });
	});

	app.get('/links/:id', requireScope('links:read'), async (context) => {
		const link = await getLink(routing, context.var.tenantId, context.req.param('id'));
		return respond({ status: 200, body: JSON.stringify({ link }) });
	});

	app.patch('/links/:id', requireScope('links:write'), async (context) => {
		const { tenantId, requestId } = context.var;
		const change = parseUpdateLink(await readJson(context.req.raw));
		const { link, eventStaged } = await changeLink(
			routing,
			tenantId,
			context.req.param('id'),
			change,
			now(),
			dependencies.linkPasswords
		);
		if (eventStaged) deliverLater(tenantId, requestId);
		return respond({ status: 200, body: JSON.stringify({ link }) });
	});

	// The image goes to the image store first; the link names it only after the store has it.
	app.put('/links/:id/preview-image', requireScope('links:write'), async (context) => {
		const body = await readImage(context.req.raw);
		const link = await setPreviewImage(routing, dependencies.previewImages, {
			tenantId: context.var.tenantId,
			linkId: context.req.param('id'),
			body,
			now: now()
		});
		return respond({ status: 200, body: JSON.stringify({ link }) });
	});

	app.delete('/links/:id/preview-image', requireScope('links:write'), async (context) => {
		const link = await removePreviewImage(routing, dependencies.previewImages, {
			tenantId: context.var.tenantId,
			linkId: context.req.param('id'),
			now: now()
		});
		return respond({ status: 200, body: JSON.stringify({ link }) });
	});

	app.get('/links/:id/analytics', requireScope('analytics:read'), async (context) => {
		const { tenantId } = context.var;
		const link = await getLink(routing, tenantId, context.req.param('id'));
		if (!dependencies.analytics) throw new AnalyticsUnavailableError();
		const analytics = await getLinkAnalytics(
			identity,
			dependencies.analytics,
			tenantId,
			link.id,
			{ from: context.req.query('from'), to: context.req.query('to') },
			now()
		);
		return respond({ status: 200, body: JSON.stringify({ analytics }) });
	});

	// The short URL never changes, so the image can be kept. A disabled link keeps its code,
	// because its address stays reserved.
	app.get('/links/:id/qr', requireScope('links:read'), async (context) => {
		const link = await getLink(routing, context.var.tenantId, context.req.param('id'));
		const format = context.req.query('format') ?? 'svg';
		if (format !== 'svg' && format !== 'png')
			throw new ApiError('INVALID_INPUT', 'Use the format svg or png.');
		const sizeText = context.req.query('size');
		const size = sizeText === undefined ? defaultQrSize : Number(sizeText);
		if (!Number.isInteger(size) || size < minQrSize || size > maxQrSize)
			throw new ApiError('INVALID_INPUT', `Use a size from ${minQrSize} to ${maxQrSize}.`);
		const headers: Record<string, string> = {
			'content-type': format === 'svg' ? 'image/svg+xml' : 'image/png',
			'cache-control': 'private, max-age=86400',
			'x-content-type-options': 'nosniff',
			'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'"
		};
		if (context.req.query('download') === '1')
			headers['content-disposition'] = `attachment; filename="${link.slug}.${format}"`;
		const body = format === 'svg' ? qrSvg(link.shortUrl, size) : await qrPng(link.shortUrl, size);
		return new Response(body, { headers });
	});

	// Pages are built from links, so they use the link scopes.
	const pageSettings = dependencies.pages ?? {};

	app.get('/pages', requireScope('links:read'), async (context) => {
		const list = await listPages(
			routing,
			context.var.tenantId,
			{ limit: pageSize(context.req.query('limit')), cursor: context.req.query('cursor') ?? null },
			pageSettings
		);
		return respond({ status: 200, body: JSON.stringify(list) });
	});

	app.post('/pages', requireScope('links:write'), async (context) => {
		const input = parseCreatePage(await readJson(context.req.raw, maxPageBodyBytes));
		const page = await createPage(routing, {
			tenantId: context.var.tenantId,
			input,
			now: now(),
			settings: pageSettings
		});
		return respond({ status: 201, body: JSON.stringify({ page }) });
	});

	app.get('/pages/:id', requireScope('links:read'), async (context) => {
		const page = await getPage(
			routing,
			context.var.tenantId,
			context.req.param('id'),
			pageSettings
		);
		return respond({ status: 200, body: JSON.stringify({ page }) });
	});

	app.patch('/pages/:id', requireScope('links:write'), async (context) => {
		const change = parseUpdatePage(await readJson(context.req.raw, maxPageBodyBytes));
		const page = await changePage(routing, {
			tenantId: context.var.tenantId,
			pageId: context.req.param('id'),
			change,
			now: now(),
			settings: pageSettings
		});
		return respond({ status: 200, body: JSON.stringify({ page }) });
	});

	app.delete('/pages/:id', requireScope('links:write'), async (context) => {
		await removePage(routing, context.var.tenantId, context.req.param('id'), now());
		return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
	});

	app.get('/domains', requireScope('domains:read'), async (context) => {
		const page = await listDomainPage(routing, domainSettings, context.var.tenantId, now());
		return respond({ status: 200, body: JSON.stringify(page) });
	});

	app.post('/domains', requireScope('domains:write'), async (context) => {
		const { requestId, tenantId } = context.var;
		const time = now();
		// A separate budget from link creation, in the same table.
		const allowance = await countCreationAttempt(routing, `${tenantId}:domains`, time, 10);
		if (!allowance.allowed)
			throw new ApiError(
				'RATE_LIMITED',
				'Too many domains added. Try again soon.',
				allowance.retryAfterSeconds
			);
		const input = parseAddDomain(await readJson(context.req.raw));
		const result = await addDomain(routing, domainSettings, {
			tenantId,
			hostname: input.hostname,
			now: time
		});
		if (result.created) {
			console.log(JSON.stringify({ event: 'domain_added', requestId, domainId: result.domain.id }));
			await noteLimitUsage(identity, routing, tenantId, time);
		}
		return respond({
			status: result.created ? 201 : 200,
			body: JSON.stringify({ domain: result.domain })
		});
	});

	app.get('/domains/:id', requireScope('domains:read'), async (context) => {
		const domain = await getDomain(
			routing,
			domainSettings,
			context.var.tenantId,
			context.req.param('id'),
			now()
		);
		return respond({ status: 200, body: JSON.stringify({ domain }) });
	});

	app.post('/domains/:id/check', requireScope('domains:write'), async (context) => {
		const domain = await checkDomain(routing, domainSettings, {
			tenantId: context.var.tenantId,
			domainId: context.req.param('id'),
			now: now()
		});
		return respond({ status: 200, body: JSON.stringify({ domain }) });
	});

	app.delete('/domains/:id', requireScope('domains:write'), async (context) => {
		const { requestId } = context.var;
		const domainId = context.req.param('id');
		await removeDomain(routing, domainSettings, {
			tenantId: context.var.tenantId,
			domainId,
			now: now()
		});
		console.log(JSON.stringify({ event: 'domain_removed', requestId, domainId }));
		return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
	});

	app.get('/usage', requireScope('usage:read'), async (context) => {
		if (!dependencies.analytics) throw new AnalyticsUnavailableError();
		const usage = await getUsage(
			identity,
			routing,
			dependencies.analytics,
			context.var.tenantId,
			now()
		);
		return respond({ status: 200, body: JSON.stringify({ usage }) });
	});

	// A workspace export is read in pages; the client writes them into one file.
	app.get('/export/links', requireScope('links:read'), async (context) => {
		const page = await exportLinks(
			routing,
			context.var.tenantId,
			context.req.query('cursor') ?? null,
			exportPageSize(context.req.query('limit'))
		);
		return respond({ status: 200, body: JSON.stringify(page) });
	});

	app.get('/export/daily-totals', requireScope('analytics:read'), async (context) => {
		if (!dependencies.analytics) throw new AnalyticsUnavailableError();
		const page = await getExportTotals(
			identity,
			dependencies.analytics,
			context.var.tenantId,
			context.req.query('cursor') ?? null,
			now()
		);
		return respond({ status: 200, body: JSON.stringify(page) });
	});

	app.get('/export/daily-dimensions', requireScope('analytics:read'), async (context) => {
		if (!dependencies.analytics) throw new AnalyticsUnavailableError();
		const page = await getExportDimensions(
			identity,
			dependencies.analytics,
			context.var.tenantId,
			context.req.query('cursor') ?? null,
			now()
		);
		return respond({ status: 200, body: JSON.stringify(page) });
	});

	// Who is calling. Needs no scope, so a client can check any token.
	app.get('/me', async (context) => {
		const { principal, tenantId, role } = context.var;
		const name = await readTenantName(identity, tenantId);
		if (name === null) throw new ApiError('NOT_FOUND', 'Workspace not found.');
		const workspace: Workspace = { id: tenantId, name, role };
		const me: ApiIdentity =
			principal.kind === 'token'
				? { kind: 'token', scopes: [...principal.scopes], token: principal.token, workspace }
				: principal.kind === 'oauth'
					? { kind: 'oauth', scopes: [...principal.scopes], workspace }
					: { kind: 'session', scopes: [...roleScopes[role]], workspace };
		return respond({ status: 200, body: JSON.stringify(me) });
	});

	// The person's workspaces, for the dashboard's workspace menu.
	app.get('/workspaces', async (context) => {
		const principal = sessionOnly(context, 'Choose the workspace in the Flared app.');
		const workspaces = (await listWorkspaces(identity, principal.userId)).filter(
			(workspace) =>
				dependencies.fixedTenantId === undefined || workspace.id === dependencies.fixedTenantId
		);
		const active = await resolveTenant(identity, {
			userId: principal.userId,
			sessionId: principal.sessionId
		});
		const list: WorkspaceList = {
			workspaces,
			activeId: active.status === 'none' ? null : active.tenantId
		};
		return respond({ status: 200, body: JSON.stringify(list) });
	});

	// Creates a workspace and makes it the session's active one, so the next page shows it.
	app.post('/workspaces', async (context) => {
		const principal = sessionOnly(context, 'Create workspaces in the Flared app.');
		const create = dependencies.createWorkspace;
		if (!create) throw new ApiError('NOT_FOUND', 'Route not found.');
		const { name } = parseWorkspaceName(await readJson(context.req.raw));
		// After an account deletion, the user can sign in until its last job ends.
		if (await accountDeletionRunning(identity, principal.userId))
			throw new ApiError('ACCOUNT_DELETING', 'This account is being deleted.');
		const result = await create({ userId: principal.userId, name, now: now() });
		if (result.status === 'limit') throw new ApiError('WORKSPACE_LIMIT_REACHED', result.message);
		if (result.status === 'unavailable')
			throw new ApiError(
				'SERVICE_UNAVAILABLE',
				'Flared cannot open a new workspace right now. Try again later.'
			);
		const selected = await setActiveWorkspace(identity, {
			userId: principal.userId,
			sessionId: principal.sessionId,
			tenantId: result.tenantId,
			now: now()
		});
		const workspace = (await listWorkspaces(identity, principal.userId)).find(
			(item) => item.id === result.tenantId
		);
		if (!workspace) throw new ApiError('NOT_FOUND', 'Workspace not found.');
		console.log(
			JSON.stringify({ event: 'workspace_created', requestId: context.var.requestId, selected })
		);
		const body: { workspace: WorkspaceSummary; active: boolean } = { workspace, active: selected };
		return respond({ status: 201, body: JSON.stringify(body) });
	});

	// Makes a workspace the session's active one. The membership check, not the request, grants
	// access; another workspace's ID answers like an unknown one.
	app.post('/workspaces/active', async (context) => {
		const principal = sessionOnly(context, 'Choose the workspace in the Flared app.');
		const { tenantId } = parseSelectWorkspace(await readJson(context.req.raw));
		const allowed =
			dependencies.fixedTenantId === undefined || tenantId === dependencies.fixedTenantId;
		if (
			!allowed ||
			!(await setActiveWorkspace(identity, {
				userId: principal.userId,
				sessionId: principal.sessionId,
				tenantId,
				now: now()
			}))
		)
			throw new ApiError('NOT_FOUND', 'Workspace not found.');
		console.log(JSON.stringify({ event: 'workspace_selected', requestId: context.var.requestId }));
		return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
	});

	// The workspace name, for the dashboard only.
	app.get('/workspace', async (context) => {
		sessionOnly(context, 'Rename the workspace from the Flared app.');
		const { tenantId, role } = context.var;
		const name = await readTenantName(identity, tenantId);
		if (name === null) throw new ApiError('NOT_FOUND', 'Workspace not found.');
		const workspace: Workspace = { id: tenantId, name, role };
		return respond({ status: 200, body: JSON.stringify({ workspace }) });
	});

	app.patch('/workspace', async (context) => {
		sessionOnly(context, 'Rename the workspace from the Flared app.');
		const { tenantId, role } = context.var;
		if (role !== 'owner')
			throw new ApiError('OWNER_REQUIRED', 'Only the workspace owner can rename it.');
		const { name } = parseWorkspaceName(await readJson(context.req.raw));
		if (!(await renameTenant(identity, tenantId, name)))
			throw new ApiError('NOT_FOUND', 'Workspace not found.');
		const workspace: Workspace = { id: tenantId, name, role };
		return respond({ status: 200, body: JSON.stringify({ workspace }) });
	});

	// A site's icon for the dashboard, from the shared store or fetched from the site. A session
	// is required and each workspace has a fetch budget, so the route is no open proxy.
	app.get('/icons/:hostname', async (context) => {
		sessionOnly(context, 'Site icons are for the Flared app.');
		const icons = dependencies.icons;
		const hostname = iconHostname(context.req.param('hostname'));
		const none = (maxAge: number) =>
			new Response(null, {
				status: 404,
				headers: { 'cache-control': `private, max-age=${maxAge}` }
			});
		if (!icons || !hostname) return none(86400);
		const time = now();
		let limited = false;
		const icon = await resolveIcon(icons.store, hostname, icons.fetch ?? fetch, time, async () => {
			const allowance = await countCreationAttempt(
				routing,
				`${context.var.tenantId}:icons`,
				time,
				icons.fetchesPerMinute ?? 60
			);
			limited = !allowance.allowed;
			return allowance.allowed;
		});
		if (icon?.status !== 'found') return none(limited ? 60 : 86400);
		return new Response(icon.body, { headers: iconHeaders(icon.type) });
	});

	app.get('/tokens', async (context) => {
		const principal = sessionOnly(context);
		const page: ApiTokenPage = {
			tokens: await listTokens(identity, principal.userId, context.var.tenantId, now()),
			freshUntil: freshUntil(principal, now())
		};
		return respond({ status: 200, body: JSON.stringify(page) });
	});

	app.post('/tokens', async (context) => {
		const { requestId, tenantId } = context.var;
		const principal = sessionOnly(context);
		if (freshUntil(principal, now()) === null)
			throw new ApiError('REAUTH_REQUIRED', 'Sign in again to create a token.');
		const input = parseCreateToken(await readJson(context.req.raw));
		const denied = input.scopes.find((scope) => !roleScopes[context.var.role].includes(scope));
		if (denied)
			throw new ApiError(
				'OWNER_REQUIRED',
				`Only the workspace owner can give a token the ${denied} scope.`
			);
		if (!dependencies.tokenAuth) throw new Error('Token creation is not configured');
		let created;
		try {
			created = await createToken(dependencies.tokenAuth, {
				userId: principal.userId,
				tenantId,
				input
			});
		} catch (error) {
			if (error instanceof TokenLimitError)
				throw new ApiError('TOKEN_LIMIT_REACHED', 'Revoke a token before you create another.');
			throw error;
		}
		console.log(
			JSON.stringify({ event: 'api_token_created', requestId, tokenId: created.token.id })
		);
		return respond({ status: 201, body: JSON.stringify(created) });
	});

	app.delete('/tokens/:id', async (context) => {
		const { requestId, tenantId } = context.var;
		const principal = sessionOnly(context);
		const id = context.req.param('id');
		if (!(await revokeToken(identity, principal.userId, tenantId, id)))
			throw new ApiError('NOT_FOUND', 'Token not found.');
		await endHooks(tenantId, { userId: principal.userId, credential: `token:${id}` }, requestId);
		console.log(JSON.stringify({ event: 'api_token_revoked', requestId, tokenId: id }));
		return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
	});

	// Apps connected through OAuth, such as AI assistants, in the signed-in person's workspace.
	app.get('/connected-apps', async (context) => {
		const principal = sessionOnly(context);
		const apps: ConnectedApp[] = (
			await listGrants(identity, principal.userId, context.var.tenantId)
		).map((grant) => ({
			clientId: grant.clientId,
			name: grant.name?.trim() || appHost(grant.clientId, grant.uri),
			kind: grant.operator ? 'app' : 'assistant',
			assistant: knownAssistant(grant.redirectUris),
			uri: grant.uri,
			scopes: grant.scopes.filter(isTokenScope),
			connectedAt: new Date(grant.connectedAt).toISOString(),
			lastActiveAt: grant.lastActiveAt === null ? null : new Date(grant.lastActiveAt).toISOString()
		}));
		const page: ConnectedAppPage = { apps };
		return respond({ status: 200, body: JSON.stringify(page) });
	});

	// Ends the app's access at once: its consent and all of its tokens.
	app.delete('/connected-apps/:clientId', async (context) => {
		const { requestId, tenantId } = context.var;
		const principal = sessionOnly(context);
		const clientId = context.req.param('clientId');
		if (!(await deleteGrant(identity, principal.userId, tenantId, clientId)))
			throw new ApiError('NOT_FOUND', 'Connected app not found.');
		await endHooks(
			tenantId,
			{ userId: principal.userId, credential: `oauth:${clientId}` },
			requestId
		);
		console.log(JSON.stringify({ event: 'oauth_grant_revoked', requestId }));
		return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
	});

	// The workspace's members. Only the owner sees the open invites.
	app.get('/members', async (context) => {
		const principal = sessionOnly(context, 'See members in the Flared app.');
		const { tenantId, role } = context.var;
		const time = now();
		const [members, invites, counted, offer] = await Promise.all([
			listMembers(identity, tenantId),
			role === 'owner' ? listInvites(identity, tenantId, time) : Promise.resolve([]),
			readMemberCount(identity, tenantId, time),
			readTransfer(identity, tenantId, time)
		]);
		if (!counted) throw new ApiError('NOT_FOUND', 'Workspace not found.');
		const page: MemberPage = {
			members: members.map((member) => ({
				userId: member.userId,
				email: member.email,
				name: member.name,
				role: member.role,
				joinedAt: new Date(member.joinedAt).toISOString(),
				you: member.userId === principal.userId
			})),
			invites: invites.map((invite) =>
				inviteSummary(invite.id, invite.email, invite.createdAt, invite.expiresAt)
			),
			used: counted.used,
			limit: counted.limit,
			transfer:
				offer && (role === 'owner' || offer.userId === principal.userId)
					? offerSummary(offer.userId, offer.email, offer.name, offer.expiresAt)
					: null
		};
		return respond({ status: 200, body: JSON.stringify(page) });
	});

	// What an invite link opens, for the person who received it.
	app.post('/invites/lookup', async (context) => {
		const principal = sessionOnly(context, 'Open the invite in the Flared app.');
		const { token } = parseInviteToken(await readJson(context.req.raw));
		const invite = await readInvite(identity, await hashInviteToken(token), now());
		if (!invite) throw new ApiError('NOT_FOUND', 'This invite has ended or was already used.');
		const user = await identity
			.prepare('SELECT email, "emailVerified" AS verified FROM "user" WHERE id = ?')
			.bind(principal.userId)
			.first<{ email: unknown; verified: unknown }>();
		const preview: InvitePreview = {
			workspaceName: invite.workspaceName,
			email: invite.email,
			expiresAt: new Date(invite.expiresAt).toISOString(),
			forYou:
				typeof user?.email === 'string' &&
				user.verified === 1 &&
				user.email.toLowerCase() === invite.email
		};
		return respond({ status: 200, body: JSON.stringify(preview) });
	});

	// Joins the workspace and opens it in this session.
	app.post('/invites/accept', async (context) => {
		const principal = sessionOnly(context, 'Accept the invite in the Flared app.');
		const { token } = parseInviteToken(await readJson(context.req.raw));
		if (await accountDeletionRunning(identity, principal.userId))
			throw new ApiError('ACCOUNT_DELETING', 'This account is being deleted.');
		const time = now();
		const result = await acceptInvite(identity, {
			tokenHash: await hashInviteToken(token),
			userId: principal.userId,
			now: time
		});
		if (result.status === 'other_email')
			throw new ApiError(
				'INVITE_FOR_ANOTHER_EMAIL',
				`This invite is for ${result.email}. Sign in with that address to accept it.`
			);
		if (result.status === 'invalid')
			throw new ApiError('NOT_FOUND', 'This invite has ended or was already used.');
		await setActiveWorkspace(identity, {
			userId: principal.userId,
			sessionId: principal.sessionId,
			tenantId: result.tenantId,
			now: time
		});
		const name = await readTenantName(identity, result.tenantId);
		if (name === null) throw new ApiError('NOT_FOUND', 'Workspace not found.');
		console.log(JSON.stringify({ event: 'invite_accepted', requestId: context.var.requestId }));
		const body: AcceptedInvite = { workspace: { id: result.tenantId, name, role: 'member' } };
		return respond({ status: 200, body: JSON.stringify(body) });
	});

	app.post('/invites', async (context) => {
		const principal = sessionOnly(context, 'Invite members in the Flared app.');
		ownerOnly(context, 'Only the workspace owner can invite members.');
		const settings = inviteSettings();
		const body = await readJson(context.req.raw);
		if (settings.delivery === 'link') {
			parseLinkInvite(body);
			return sendInvite(context, principal, settings, null, false);
		}
		const { email } = parseInvite(body);
		return sendInvite(context, principal, settings, email, false);
	});

	// A new link with a new expiry; the old link stops working. An invite shared as a link has no
	// resend: the owner cancels it and creates another.
	app.post('/invites/:id/resend', async (context) => {
		const principal = sessionOnly(context, 'Invite members in the Flared app.');
		ownerOnly(context, 'Only the workspace owner can invite members.');
		const settings = inviteSettings();
		const email = await readInviteEmail(identity, context.var.tenantId, context.req.param('id'));
		if (email === null) throw new ApiError('NOT_FOUND', 'Invite not found.');
		return sendInvite(context, principal, settings, email, true);
	});

	app.delete('/invites/:id', async (context) => {
		const principal = sessionOnly(context, 'Manage invites in the Flared app.');
		ownerOnly(context, 'Only the workspace owner can cancel invites.');
		inviteSettings();
		if (
			!(await cancelInvite(identity, {
				tenantId: context.var.tenantId,
				inviteId: context.req.param('id'),
				actorUserId: principal.userId,
				now: now()
			}))
		)
			throw new ApiError('NOT_FOUND', 'Invite not found.');
		console.log(JSON.stringify({ event: 'invite_cancelled', requestId: context.var.requestId }));
		return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
	});

	// The owner removes a member. The member's tokens and connected apps for this workspace end.
	app.delete('/members/:userId', async (context) => {
		const principal = sessionOnly(context, 'Manage members in the Flared app.');
		ownerOnly(context, 'Only the workspace owner can remove members.');
		const userId = context.req.param('userId');
		if (userId === principal.userId)
			throw new ApiError(
				'OWNER_CANNOT_LEAVE',
				'You own this workspace. Delete the workspace, or give it to a member first.'
			);
		if (
			!(await removeMember(identity, {
				tenantId: context.var.tenantId,
				userId,
				actorUserId: principal.userId,
				now: now()
			}))
		)
			throw new ApiError('NOT_FOUND', 'Member not found.');
		await endHooks(context.var.tenantId, { userId }, context.var.requestId);
		console.log(JSON.stringify({ event: 'member_removed', requestId: context.var.requestId }));
		return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
	});

	// A member leaves the workspace the page shows. The page must name it, so a tab left on
	// another workspace cannot leave this one.
	app.post('/workspace/leave', async (context) => {
		const principal = sessionOnly(context, 'Leave the workspace in the Flared app.');
		const { tenantId, role, requestId } = context.var;
		requireShown(context);
		if (role === 'owner')
			throw new ApiError(
				'OWNER_CANNOT_LEAVE',
				'You own this workspace. Delete the workspace, or give it to a member first.'
			);
		if (
			!(await removeMember(identity, {
				tenantId,
				userId: principal.userId,
				actorUserId: principal.userId,
				now: now()
			}))
		)
			throw new ApiError('NOT_FOUND', 'Workspace not found.');
		await endHooks(tenantId, { userId: principal.userId }, requestId);
		console.log(JSON.stringify({ event: 'workspace_left', requestId }));
		return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
	});

	// The owner creates a link that lets a member set a new password, where invites are shared as
	// links. Like an invite, it is shown once; it replaces an earlier one and works for 24 hours.
	// It can take over the member's account, so it needs a recent sign-in.
	app.post('/members/:userId/password-reset', async (context) => {
		const principal = sessionOnly(context, 'Reset passwords in the Flared app.');
		ownerOnly(context, 'Only the workspace owner can reset a member’s password.');
		const settings = linkSettings();
		const { tenantId, requestId } = context.var;
		requireShown(context);
		const time = now();
		if (freshUntil(principal, time) === null)
			throw new ApiError('REAUTH_REQUIRED', 'Sign in again to reset a member’s password.');
		if (!(await countInviteEmail(identity, tenantId, time, invitesPerDay(settings))))
			throw new ApiError(
				'RATE_LIMITED',
				'This workspace created many links today. Try again tomorrow.',
				Math.ceil((dayMs - (time % dayMs)) / 1000)
			);
		const token = newInviteToken();
		const expiresAt = time + passwordResetLifetimeMs;
		if (
			!(await createPasswordReset(identity, {
				tenantId,
				userId: context.req.param('userId'),
				createdBy: principal.userId,
				tokenHash: await hashInviteToken(token),
				now: time,
				expiresAt
			}))
		)
			throw new ApiError('NOT_FOUND', 'Member not found.');
		console.log(JSON.stringify({ event: 'password_reset_created', requestId }));
		const body: PasswordResetLink = {
			url: settings.resetUrl(token),
			expiresAt: new Date(expiresAt).toISOString()
		};
		return respond({ status: 201, body: JSON.stringify(body) });
	});

	// The owner offers the workspace to a member, who accepts it on the members page. A new offer
	// replaces an open one. Giving the workspace away needs a recent sign-in, as deleting it does.
	app.post('/workspace/transfer', async (context) => {
		const principal = sessionOnly(context, 'Transfer the workspace in the Flared app.');
		ownerOnly(context, 'Only the workspace owner can make a member the owner.');
		const { tenantId, requestId } = context.var;
		requireShown(context);
		const time = now();
		if (freshUntil(principal, time) === null)
			throw new ApiError('REAUTH_REQUIRED', 'Sign in again to make a member the owner.');
		const { userId } = parseTransfer(await readJson(context.req.raw));
		const expiresAt = time + transferLifetimeDays * dayMs;
		if (
			!(await offerTransfer(identity, {
				tenantId,
				fromUserId: principal.userId,
				toUserId: userId,
				now: time,
				expiresAt
			}))
		)
			throw new ApiError('NOT_FOUND', 'Member not found.');
		const [workspaceName, people] = await Promise.all([
			readTenantName(identity, tenantId),
			identity
				.prepare(
					'SELECT id, email, COALESCE("displayUsername", email) AS name FROM "user" WHERE id IN (?, ?)'
				)
				.bind(principal.userId, userId)
				.all<{ id: unknown; email: unknown; name: unknown }>()
		]);
		const field = (id: string, key: 'email' | 'name') => {
			const value = people.results.find((row) => row.id === id)?.[key];
			return typeof value === 'string' ? value : null;
		};
		const [from, to, toName] = [
			field(principal.userId, 'email'),
			field(userId, 'email'),
			field(userId, 'name')
		];
		if (to === null || toName === null) throw new ApiError('NOT_FOUND', 'Member not found.');
		// The offer stands without the email: the member also sees it on the members page.
		let emailSent = false;
		const settings = dependencies.invites;
		if (settings?.delivery === 'email' && workspaceName !== null && from !== null)
			try {
				if (await countInviteEmail(identity, tenantId, time, invitesPerDay(settings))) {
					await settings.email.send(
						transferEmail({ to, workspaceName, from, url: settings.membersUrl, expiresAt })
					);
					emailSent = true;
				}
			} catch {
				console.error(JSON.stringify({ event: 'transfer_email_failed', requestId }));
			}
		console.log(JSON.stringify({ event: 'transfer_offered', requestId, emailSent }));
		const body: { transfer: OwnershipOffer; emailSent: boolean } = {
			transfer: offerSummary(userId, to, toName, expiresAt),
			emailSent
		};
		return respond({ status: 201, body: JSON.stringify(body) });
	});

	// The owner withdraws the offer, or the member it names declines it.
	app.delete('/workspace/transfer', async (context) => {
		const principal = sessionOnly(context, 'Transfer the workspace in the Flared app.');
		const { tenantId, role, requestId } = context.var;
		requireShown(context);
		if (
			!(await cancelTransfer(identity, {
				tenantId,
				userId: principal.userId,
				owner: role === 'owner',
				now: now()
			}))
		)
			throw new ApiError('NOT_FOUND', 'Offer not found.');
		console.log(JSON.stringify({ event: 'transfer_cancelled', requestId }));
		return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
	});

	// The member the offer names becomes the owner, and the owner becomes a member.
	app.post('/workspace/transfer/accept', async (context) => {
		const principal = sessionOnly(context, 'Accept the workspace in the Flared app.');
		const { tenantId, requestId } = context.var;
		requireShown(context);
		if (await accountDeletionRunning(identity, principal.userId))
			throw new ApiError('ACCOUNT_DELETING', 'This account is being deleted.');
		const input: TransferInput = { tenantId, toUserId: principal.userId, now: now() };
		const result = dependencies.transferOwnership
			? await dependencies.transferOwnership(input)
			: (await transferOwnership(identity, input))
				? ({ status: 'transferred' } as const)
				: ({ status: 'invalid' } as const);
		if (result.status === 'limit') throw new ApiError('WORKSPACE_LIMIT_REACHED', result.message);
		if (result.status === 'invalid')
			throw new ApiError('NOT_FOUND', 'This offer has ended or was withdrawn.');
		const name = await readTenantName(identity, tenantId);
		if (name === null) throw new ApiError('NOT_FOUND', 'Workspace not found.');
		console.log(JSON.stringify({ event: 'transfer_accepted', requestId }));
		const workspace: Workspace = { id: tenantId, name, role: 'owner' };
		return respond({ status: 200, body: JSON.stringify({ workspace }) });
	});

	// Webhook endpoints of the workspace. Only the owner manages them, from the dashboard.
	app.get('/webhooks', async (context) => {
		sessionOnly(context, 'Manage webhooks in the Flared app.');
		ownerOnly(context, 'Only the workspace owner can manage webhooks.');
		const settings = webhookSettings();
		const listed = await listWebhookEndpoints(routing, context.var.tenantId);
		if (!listed) throw new ApiError('NOT_FOUND', 'Workspace not found.');
		const page: WebhookEndpointPage = {
			endpoints: await Promise.all(listed.endpoints.map((row) => endpointBody(settings, row))),
			used: listed.used,
			limit: listed.limit,
			eventTypes: [...subscribableWebhookEvents]
		};
		return respond({ status: 200, body: JSON.stringify(page) });
	});

	// The secret is shown in this response only; it can sign requests to the receiver, so adding
	// an endpoint needs a recent sign-in, as creating a token does.
	app.post('/webhooks', async (context) => {
		const principal = sessionOnly(context, 'Manage webhooks in the Flared app.');
		ownerOnly(context, 'Only the workspace owner can manage webhooks.');
		const settings = webhookSettings();
		const { tenantId, requestId } = context.var;
		const time = now();
		if (freshUntil(principal, time) === null)
			throw new ApiError('REAUTH_REQUIRED', 'Sign in again to add a webhook endpoint.');
		const input = parseCreateWebhook(await readJson(context.req.raw), webhookReserved);
		const id = `whk_${crypto.randomUUID().replaceAll('-', '')}`;
		const result = await createWebhookEndpoint(routing, {
			id,
			tenantId,
			url: input.url,
			events: input.events,
			milestoneInterval: input.milestoneInterval,
			keyId: await webhookKeyId(settings),
			now: time
		});
		if (result.status === 'no_workspace') throw new ApiError('NOT_FOUND', 'Workspace not found.');
		if (result.status === 'limit')
			throw new ApiError(
				'WEBHOOK_LIMIT_REACHED',
				result.limit === 0
					? 'Webhooks are not available for this workspace.'
					: `This workspace has room for ${result.limit} webhook endpoints. Delete an endpoint first.`
			);
		console.log(JSON.stringify({ event: 'webhook_endpoint_created', requestId, endpointId: id }));
		const body: CreatedWebhookEndpoint = {
			endpoint: await endpointBody(settings, result.endpoint),
			secret: await endpointSecret(settings.secret, id, result.endpoint.secretVersion)
		};
		return respond({ status: 201, body: JSON.stringify(body) });
	});

	app.patch('/webhooks/:id', async (context) => {
		sessionOnly(context, 'Manage webhooks in the Flared app.');
		ownerOnly(context, 'Only the workspace owner can manage webhooks.');
		const settings = webhookSettings();
		const change = parseUpdateWebhook(await readJson(context.req.raw), webhookReserved);
		const row = await updateWebhookEndpoint(
			routing,
			context.var.tenantId,
			context.req.param('id'),
			{
				...change,
				now: now()
			}
		);
		if (!row) throw new ApiError('NOT_FOUND', 'Webhook endpoint not found.');
		return respond({
			status: 200,
			body: JSON.stringify({ endpoint: await endpointBody(settings, row) })
		});
	});

	// Removes the endpoint and its delivery history. Allowed while the workspace is suspended.
	app.delete('/webhooks/:id', async (context) => {
		sessionOnly(context, 'Manage webhooks in the Flared app.');
		ownerOnly(context, 'Only the workspace owner can manage webhooks.');
		webhookSettings();
		const endpointId = context.req.param('id');
		if (!(await deleteWebhookEndpoint(routing, context.var.tenantId, endpointId)))
			throw new ApiError('NOT_FOUND', 'Webhook endpoint not found.');
		console.log(
			JSON.stringify({
				event: 'webhook_endpoint_deleted',
				requestId: context.var.requestId,
				endpointId
			})
		);
		return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
	});

	// A new secret, shown once. The previous one keeps signing for 24 hours beside it, unless it
	// came from a deployment secret that has changed since.
	app.post('/webhooks/:id/secret', async (context) => {
		const principal = sessionOnly(context, 'Manage webhooks in the Flared app.');
		ownerOnly(context, 'Only the workspace owner can manage webhooks.');
		const settings = webhookSettings();
		const time = now();
		if (freshUntil(principal, time) === null)
			throw new ApiError('REAUTH_REQUIRED', 'Sign in again to rotate the secret.');
		const endpointId = context.req.param('id');
		const row = await rotateWebhookSecret(routing, context.var.tenantId, endpointId, {
			keyId: await webhookKeyId(settings),
			now: time,
			previousUntil: time + secretGraceMs
		});
		if (!row) throw new ApiError('NOT_FOUND', 'Webhook endpoint not found.');
		console.log(
			JSON.stringify({
				event: 'webhook_secret_rotated',
				requestId: context.var.requestId,
				endpointId
			})
		);
		const body: CreatedWebhookEndpoint = {
			endpoint: await endpointBody(settings, row),
			secret: await endpointSecret(settings.secret, endpointId, row.secretVersion)
		};
		return respond({ status: 200, body: JSON.stringify(body) });
	});

	// Sends a webhook.test event to the endpoint now, also when it is off, and returns the
	// delivery with its result.
	app.post('/webhooks/:id/test', async (context) => {
		sessionOnly(context, 'Manage webhooks in the Flared app.');
		ownerOnly(context, 'Only the workspace owner can manage webhooks.');
		const settings = webhookSettings();
		const { tenantId, requestId } = context.var;
		const endpointId = context.req.param('id');
		const listed = await listWebhookEndpoints(routing, tenantId);
		if (!listed?.endpoints.some((endpoint) => endpoint.id === endpointId))
			throw new ApiError('NOT_FOUND', 'Webhook endpoint not found.');
		if (listed.limit === 0)
			throw new ApiError('WEBHOOK_LIMIT_REACHED', 'Webhooks are not available for this workspace.');
		const time = now();
		const allowance = await reserveCreationWindow(
			routing,
			`${tenantId}:webhook-tests`,
			time,
			hourMs,
			1,
			settings.testsPerHour ?? 10
		);
		if (!allowance.allowed)
			throw new ApiError(
				'RATE_LIMITED',
				'Too many test events this hour. Try again later.',
				allowance.retryAfterSeconds
			);
		const eventId = newWebhookEventId();
		if (
			!(await insertTestEvent(routing, {
				id: eventId,
				tenantId,
				endpointId,
				payload: JSON.stringify({ message: 'Test event from Flared.' }),
				now: time
			}))
		)
			throw new ApiError('NOT_FOUND', 'Webhook endpoint not found.');
		await deliverWebhookEvent(routing, tenantId, eventId, {
			secret: settings.secret,
			reservedHostnames: webhookReserved,
			fetch: settings.fetch,
			transports: settings.transports,
			now
		});
		const delivery = (await listEndpointDeliveries(routing, tenantId, endpointId)).find(
			(item) => item.eventId === eventId
		);
		if (!delivery)
			throw new ApiError('SERVICE_UNAVAILABLE', 'The test event was not sent. Try again.');
		console.log(JSON.stringify({ event: 'webhook_test_sent', requestId, endpointId }));
		return respond({
			status: 200,
			body: JSON.stringify({ delivery: deliverySummary(delivery) })
		});
	});

	// The endpoint's 50 newest deliveries, newest first.
	app.get('/webhooks/:id/deliveries', async (context) => {
		sessionOnly(context, 'Manage webhooks in the Flared app.');
		ownerOnly(context, 'Only the workspace owner can manage webhooks.');
		webhookSettings();
		const { tenantId } = context.var;
		const endpointId = context.req.param('id');
		if (!(await readWebhookEndpoint(routing, tenantId, endpointId)))
			throw new ApiError('NOT_FOUND', 'Webhook endpoint not found.');
		const page: WebhookDeliveryPage = {
			deliveries: (await listEndpointDeliveries(routing, tenantId, endpointId)).map(deliverySummary)
		};
		return respond({ status: 200, body: JSON.stringify(page) });
	});

	// A client such as Zapier subscribes a target URL for one event. Any member may: a hook carries
	// only link data that every member can read. The workspace needs webhooks on its plan.
	app.post('/hooks', requireScope('links:read'), async (context) => {
		const { allowedHosts } = hookSettings();
		const { tenantId, requestId, principal } = context.var;
		const input = parseCreateHook(await readJson(context.req.raw), allowedHosts);
		const time = now();
		const id = `hok_${crypto.randomUUID().replaceAll('-', '')}`;
		const result = await subscribeHook(routing, {
			id,
			tenantId,
			event: input.event,
			targetUrl: input.targetUrl,
			milestoneInterval: input.milestoneInterval,
			maker: { userId: principal.userId, credential: hookCredential(principal) },
			now: time,
			expiresAt: time + hookLifetimeMs
		});
		if (result.status === 'no_workspace') throw new ApiError('NOT_FOUND', 'Workspace not found.');
		if (result.status === 'limit')
			throw new ApiError(
				'WEBHOOK_LIMIT_REACHED',
				result.limit === 0
					? 'Hooks are not available for this workspace.'
					: `This workspace has room for ${result.limit} hooks. Delete a hook first.`
			);
		console.log(JSON.stringify({ event: 'hook_created', requestId, hookId: id }));
		const { endpoint } = result;
		const hook: Hook = {
			id: endpoint.id,
			event: input.event,
			milestoneInterval: endpoint.milestoneInterval,
			createdAt: new Date(endpoint.createdAt).toISOString(),
			renewAt: new Date(endpoint.createdAt + hookRenewMs).toISOString(),
			expiresAt: new Date(endpoint.expiresAt ?? time + hookLifetimeMs).toISOString()
		};
		const body: CreatedHook = { hook };
		return respond({ status: 201, body: JSON.stringify(body) });
	});

	// A member deletes their own hooks; the owner deletes any of the workspace. Allowed while the
	// workspace is suspended.
	app.delete('/hooks/:id', requireScope('links:read'), async (context) => {
		hookSettings();
		const { tenantId, requestId, principal, role } = context.var;
		const hookId = context.req.param('id');
		const match: HookMatch = role === 'owner' ? { hookId } : { hookId, userId: principal.userId };
		if ((await deleteHooks(routing, tenantId, match)) === 0)
			throw new ApiError('NOT_FOUND', 'Hook not found.');
		console.log(JSON.stringify({ event: 'hook_deleted', requestId, hookId }));
		return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
	});

	function automationFeatures(): AutomationFeatures {
		if (!dependencies.automations) throw new ApiError('NOT_FOUND', 'Route not found.');
		return dependencies.automations;
	}

	// Before the scope check, so an installation without automations answers 404 to every caller.
	const automationsOn: MiddlewareHandler<{ Variables: Variables }> = async (_context, next) => {
		automationFeatures();
		await next();
	};

	// send_webhook names an http endpoint of the workspace; post_message an endpoint of another
	// transport, such as a channel the edition added.
	const endpointMissing = (actions: readonly AutomationAction[]) => {
		const kinds = new Set(actions.map((action) => action.type));
		const message = kinds.has('post_message')
			? kinds.has('send_webhook')
				? 'Choose a webhook endpoint and a message target of this workspace.'
				: 'Choose a message target of this workspace.'
			: 'Choose a webhook endpoint of this workspace.';
		return new LinkInputError('endpointId', message);
	};

	const automationLimitError = (limit: number) =>
		new ApiError(
			'AUTOMATION_LIMIT_REACHED',
			limit === 0
				? 'Automations are not available for this workspace.'
				: `This workspace has room for ${limit} automations. Delete an automation first.`
		);

	// The template is read first, so the end date is checked against its trigger. A
	// destination_down template goes only on links whose destination a check may request, on
	// none of the installation's own hostnames.
	async function apply(
		context: ApiContext,
		automationId: string,
		linkIds: string[],
		input: { endsAt?: string },
		time: number
	): Promise<Extract<LinkApplyResult, { status: 'done' }>> {
		const { tenantId, requestId } = context.var;
		const automation = await readAutomation(routing, tenantId, automationId);
		if (!automation) throw new ApiError('NOT_FOUND', 'Automation not found.');
		const endsAt = automationEndsAt(automation.trigger.type, input);
		const result = await applyToLinks(
			{ identity, routing, analytics: dependencies.analytics },
			{ tenantId, automationId, linkIds, endsAt, now: time },
			automation.trigger.type,
			webhookReserved
		);
		if (result.status === 'not_found') throw new ApiError('NOT_FOUND', 'Automation not found.');
		if (result.status === 'off') throw automationLimitError(0);
		console.log(
			JSON.stringify({
				event: 'automation_applied',
				requestId,
				automationId,
				applied: result.links.filter((link) => link.outcome === 'applied').length
			})
		);
		return result;
	}

	// The workspace's templates. Any principal with links:read may list them, to apply one.
	app.get('/automations', automationsOn, requireScope('links:read'), async (context) => {
		const listed = await listAutomations(routing, context.var.tenantId);
		if (!listed) throw new ApiError('NOT_FOUND', 'Workspace not found.');
		return respond({
			status: 200,
			body: JSON.stringify(automationPage(listed, automationFeatures()))
		});
	});

	// Only the owner creates, edits, and deletes templates, from the dashboard.
	app.post('/automations', automationsOn, async (context) => {
		sessionOnly(context, 'Manage automations in the Flared app.');
		ownerOnly(context, 'Only the workspace owner can manage automations.');
		const { tenantId, requestId } = context.var;
		const input = parseCreateAutomation(await readJson(context.req.raw), automationFeatures());
		const id = newAutomationId();
		const result = await createAutomation(routing, { id, tenantId, ...input, now: now() });
		if (result.status === 'no_workspace') throw new ApiError('NOT_FOUND', 'Workspace not found.');
		if (result.status === 'limit') throw automationLimitError(result.limit);
		if (result.status === 'endpoint_missing') throw endpointMissing(input.actions);
		console.log(JSON.stringify({ event: 'automation_created', requestId, automationId: id }));
		return respond({
			status: 201,
			body: JSON.stringify({ automation: automationSummary(result.automation) })
		});
	});

	app.patch('/automations/:id', automationsOn, async (context) => {
		sessionOnly(context, 'Manage automations in the Flared app.');
		ownerOnly(context, 'Only the workspace owner can manage automations.');
		const change = parseUpdateAutomation(await readJson(context.req.raw), automationFeatures());
		const result = await updateAutomation(routing, context.var.tenantId, context.req.param('id'), {
			...change,
			now: now()
		});
		if (result.status === 'not_found') throw new ApiError('NOT_FOUND', 'Automation not found.');
		if (result.status === 'trigger_type')
			throw new LinkInputError(
				'trigger',
				'The trigger type of an automation cannot change. Create another automation.'
			);
		if (result.status === 'endpoint_missing') throw endpointMissing(change.actions ?? []);
		return respond({
			status: 200,
			body: JSON.stringify({ automation: automationSummary(result.automation) })
		});
	});

	// Removes the template, its applications, and its runs. Allowed while the workspace is
	// suspended.
	app.delete('/automations/:id', automationsOn, async (context) => {
		sessionOnly(context, 'Manage automations in the Flared app.');
		ownerOnly(context, 'Only the workspace owner can manage automations.');
		const automationId = context.req.param('id');
		if (!(await deleteAutomation(routing, context.var.tenantId, automationId)))
			throw new ApiError('NOT_FOUND', 'Automation not found.');
		console.log(
			JSON.stringify({
				event: 'automation_deleted',
				requestId: context.var.requestId,
				automationId
			})
		);
		return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
	});

	// The template's 100 newest runs, newest first, for every member in the dashboard.
	app.get('/automations/:id/runs', automationsOn, async (context) => {
		sessionOnly(context, 'See automation runs in the Flared app.');
		const runs = await listAutomationRuns(routing, context.var.tenantId, context.req.param('id'));
		if (!runs) throw new ApiError('NOT_FOUND', 'Automation not found.');
		const page: AutomationRunPage = { runs: runs.map(runSummary) };
		return respond({ status: 200, body: JSON.stringify(page) });
	});

	// Applies the template to up to 100 links; each link is applied or fails on its own.
	app.post(
		'/automations/:id/links',
		automationsOn,
		requireScope('links:write'),
		async (context) => {
			const time = now();
			let input;
			try {
				input = parseApplyAutomationLinks(await readJson(context.req.raw), time);
			} catch (error) {
				if (error instanceof ImportRequestError)
					return failure(error.code, error.message, context.var.requestId, {}, error.field);
				throw error;
			}
			const result = await apply(context, context.req.param('id'), input.linkIds, input, time);
			const body: ApplyAutomationLinksResult = { results: result.links.map(applyLinkResult) };
			return respond({ status: 200, body: JSON.stringify(body) });
		}
	);

	app.get('/links/:id/automations', automationsOn, requireScope('links:read'), async (context) => {
		const { tenantId } = context.var;
		const link = await getLink(routing, tenantId, context.req.param('id'));
		const page: LinkAutomationPage = {
			linkId: link.id,
			automations: (await listLinkAutomations(routing, tenantId, link.id)).map(
				linkAutomationSummary
			)
		};
		return respond({ status: 200, body: JSON.stringify(page) });
	});

	// Applies one template to one link. A template that waits with the same end date is left as
	// it is; one that already ran is armed again.
	app.put(
		'/links/:id/automations/:automationId',
		automationsOn,
		requireScope('links:write'),
		async (context) => {
			const time = now();
			const input = parseApplyAutomation(await readOptionalJson(context.req.raw), time);
			const linkId = context.req.param('id');
			const result = await apply(context, context.req.param('automationId'), [linkId], input, time);
			const outcome = result.links[0]?.outcome ?? 'not_found';
			if (outcome === 'not_checkable')
				throw new LinkInputError('destination', applyRefusals.not_checkable.message);
			if (outcome !== 'applied' && outcome !== 'unchanged') {
				const refused = applyLinkResult({ linkId, outcome }).error;
				if (refused) throw new ApiError(refused.code, refused.message);
			}
			const body: ApplyLinkAutomationResult = {
				linkId,
				status: outcome === 'unchanged' ? 'unchanged' : 'applied',
				automations: (await listLinkAutomations(routing, context.var.tenantId, linkId)).map(
					linkAutomationSummary
				)
			};
			return respond({ status: 200, body: JSON.stringify(body) });
		}
	);

	// The template stays in the workspace. Allowed while the workspace is suspended.
	app.delete(
		'/links/:id/automations/:automationId',
		automationsOn,
		requireScope('links:write'),
		async (context) => {
			const removed = await removeLinkAutomation(
				routing,
				context.var.tenantId,
				context.req.param('id'),
				context.req.param('automationId')
			);
			if (!removed) throw new ApiError('NOT_FOUND', 'This automation is not on the link.');
			return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
		}
	);

	function inviteSettings(): InviteSettings {
		if (!dependencies.invites) throw new ApiError('NOT_FOUND', 'Route not found.');
		return dependencies.invites;
	}

	function linkSettings(): LinkInviteSettings {
		const settings = inviteSettings();
		if (settings.delivery !== 'link') throw new ApiError('NOT_FOUND', 'Route not found.');
		return settings;
	}

	// Counts the email or link against the day's limit, writes the invite within the member limit,
	// then sends the email or returns the link. A failed email leaves the invite, and the owner
	// can send it again. email is null for an invite shared as a link.
	async function sendInvite(
		context: ApiContext,
		principal: Extract<ApiPrincipal, { kind: 'session' }>,
		settings: InviteSettings,
		email: string | null,
		renew: boolean
	): Promise<Response> {
		const { tenantId, requestId } = context.var;
		const time = now();
		if (!(await countInviteEmail(identity, tenantId, time, invitesPerDay(settings))))
			throw new ApiError(
				'RATE_LIMITED',
				'This workspace sent many invites today. Try again tomorrow.',
				Math.ceil((dayMs - (time % dayMs)) / 1000)
			);
		const token = newInviteToken();
		const expiresAt = time + inviteLifetimeDays * dayMs;
		const result = await createInvite(identity, {
			id: crypto.randomUUID(),
			tenantId,
			email,
			tokenHash: await hashInviteToken(token),
			invitedBy: principal.userId,
			now: time,
			expiresAt,
			renew
		});
		if (result.status === 'member')
			throw new ApiError('ALREADY_MEMBER', 'This person is already a member.');
		if (result.status === 'pending')
			throw new ApiError(
				'INVITE_PENDING',
				'This address already has an invite. Send it again from the list.'
			);
		if (result.status === 'limit')
			throw new ApiError(
				'MEMBER_LIMIT_REACHED',
				`This workspace has room for ${result.limit} members, open invites included. Remove a member or cancel an invite first.`
			);
		if (result.status === 'no_workspace') throw new ApiError('NOT_FOUND', 'Workspace not found.');
		if (settings.delivery === 'link') {
			console.log(JSON.stringify({ event: 'invite_link_created', requestId }));
			const created: CreatedInvite = {
				invite: inviteSummary(result.id, null, time, expiresAt),
				emailSent: false,
				url: settings.inviteUrl(token)
			};
			return respond({ status: 201, body: JSON.stringify(created) });
		}
		// The email routes always parse an address.
		if (email === null) throw new ApiError('INVALID_INPUT', 'Enter an email address.');
		const [workspaceName, inviter] = await Promise.all([
			readTenantName(identity, tenantId),
			identity
				.prepare('SELECT email FROM "user" WHERE id = ?')
				.bind(principal.userId)
				.first<{ email: unknown }>()
		]);
		let emailSent = false;
		if (workspaceName !== null && typeof inviter?.email === 'string')
			try {
				await settings.email.send(
					inviteEmail({
						to: email,
						workspaceName,
						invitedBy: inviter.email,
						url: settings.inviteUrl(token),
						expiresAt
					})
				);
				emailSent = true;
			} catch {
				console.error(JSON.stringify({ event: 'invite_email_failed', requestId }));
			}
		console.log(
			JSON.stringify({ event: renew ? 'invite_resent' : 'invite_created', requestId, emailSent })
		);
		const body: CreatedInvite = {
			invite: inviteSummary(result.id, email, time, expiresAt),
			emailSent
		};
		return respond({ status: renew ? 200 : 201, body: JSON.stringify(body) });
	}

	app.all('/links', (context) => methodNotAllowed(context, 'GET, POST'));
	app.all('/links/:id', (context) => methodNotAllowed(context, 'GET, PATCH'));
	app.all('/links/:id/analytics', (context) => methodNotAllowed(context, 'GET'));
	app.all('/links/:id/qr', (context) => methodNotAllowed(context, 'GET'));
	app.all('/domains', (context) => methodNotAllowed(context, 'GET, POST'));
	app.all('/domains/:id', (context) => methodNotAllowed(context, 'GET, DELETE'));
	app.all('/domains/:id/check', (context) => methodNotAllowed(context, 'POST'));
	app.all('/usage', (context) => methodNotAllowed(context, 'GET'));
	app.all('/export/links', (context) => methodNotAllowed(context, 'GET'));
	app.all('/export/daily-totals', (context) => methodNotAllowed(context, 'GET'));
	app.all('/export/daily-dimensions', (context) => methodNotAllowed(context, 'GET'));
	app.all('/me', (context) => methodNotAllowed(context, 'GET'));
	app.all('/workspace', (context) => methodNotAllowed(context, 'GET, PATCH'));
	app.all('/workspaces', (context) => methodNotAllowed(context, 'GET, POST'));
	app.all('/workspaces/active', (context) => methodNotAllowed(context, 'POST'));
	app.all('/icons/:hostname', (context) => methodNotAllowed(context, 'GET'));
	app.all('/tokens', (context) => methodNotAllowed(context, 'GET, POST'));
	app.all('/tokens/:id', (context) => methodNotAllowed(context, 'DELETE'));
	app.all('/connected-apps', (context) => methodNotAllowed(context, 'GET'));
	app.all('/connected-apps/:clientId', (context) => methodNotAllowed(context, 'DELETE'));
	app.all('/members', (context) => methodNotAllowed(context, 'GET'));
	app.all('/members/:userId', (context) => methodNotAllowed(context, 'DELETE'));
	app.all('/workspace/leave', (context) => methodNotAllowed(context, 'POST'));
	app.all('/workspace/transfer', (context) => methodNotAllowed(context, 'POST, DELETE'));
	app.all('/workspace/transfer/accept', (context) => methodNotAllowed(context, 'POST'));
	app.all('/invites', (context) => methodNotAllowed(context, 'POST'));
	app.all('/invites/lookup', (context) => methodNotAllowed(context, 'POST'));
	app.all('/invites/accept', (context) => methodNotAllowed(context, 'POST'));
	app.all('/invites/:id', (context) => methodNotAllowed(context, 'DELETE'));
	app.all('/invites/:id/resend', (context) => methodNotAllowed(context, 'POST'));
	app.all('/webhooks', (context) => methodNotAllowed(context, 'GET, POST'));
	app.all('/webhooks/:id', (context) => methodNotAllowed(context, 'PATCH, DELETE'));
	app.all('/webhooks/:id/secret', (context) => methodNotAllowed(context, 'POST'));
	app.all('/webhooks/:id/test', (context) => methodNotAllowed(context, 'POST'));
	app.all('/webhooks/:id/deliveries', (context) => methodNotAllowed(context, 'GET'));
	app.all('/hooks', (context) => methodNotAllowed(context, 'POST'));
	app.all('/hooks/:id', (context) => methodNotAllowed(context, 'DELETE'));
	app.all('/automations', (context) => methodNotAllowed(context, 'GET, POST'));
	app.all('/automations/:id', (context) => methodNotAllowed(context, 'PATCH, DELETE'));
	app.all('/automations/:id/links', (context) => methodNotAllowed(context, 'POST'));
	app.all('/automations/:id/runs', (context) => methodNotAllowed(context, 'GET'));
	app.all('/links/:id/automations', (context) => methodNotAllowed(context, 'GET'));
	app.all('/links/:id/automations/:automationId', (context) =>
		methodNotAllowed(context, 'PUT, DELETE')
	);
	return app;
}

// A suspended workspace keeps what takes nothing new: the dashboard reads its data, a person
// may end a token or connected app, the owner may remove a member, a webhook endpoint, or an
// automation, a member may take an automation off a link or delete a hook, and a member may
// leave. A token or connected app may only export and delete a hook.
function allowedWhileSuspended(principal: ApiPrincipal, method: string, path: string): boolean {
	const read = method === 'GET' || method === 'HEAD';
	if (principal.kind === 'session')
		return (
			read ||
			(method === 'DELETE' &&
				(/^\/v1\/(?:tokens|connected-apps|members|webhooks|automations|hooks)\/[^/]+$/.test(path) ||
					/^\/v1\/links\/[^/]+\/automations\/[^/]+$/.test(path))) ||
			(method === 'POST' && path === '/v1/workspace/leave')
		);
	return (
		(read && (path.startsWith('/v1/export/') || path === '/v1/me')) ||
		(method === 'DELETE' && /^\/v1\/hooks\/[^/]+$/.test(path))
	);
}

// The credential a hook was made with, so revoking it deletes the hook.
function hookCredential(principal: ApiPrincipal): string {
	if (principal.kind === 'token') return `token:${principal.token.id}`;
	if (principal.kind === 'oauth') return `oauth:${principal.clientId}`;
	return 'session';
}

// A session holds every scope; a token or connected app must hold the route's scope. Each
// also needs a role that allows the scope, checked on every request, so a role change applies to
// credentials made before it.
function requireScope(scope: TokenScope): MiddlewareHandler<{ Variables: Variables }> {
	return async (context, next) => {
		const { principal, role } = context.var;
		if (principal.kind !== 'session' && !principal.scopes.includes(scope))
			throw new ApiError('INSUFFICIENT_SCOPE', `This token needs the ${scope} scope.`);
		if (!roleScopes[role].includes(scope))
			throw new ApiError('OWNER_REQUIRED', 'Only the workspace owner can do this.');
		await next();
	};
}

// A client without a name is shown by its site or client ID host.
function appHost(clientId: string, uri: string | null): string {
	for (const value of [uri, clientId])
		try {
			if (value) return new URL(value).host || 'Unnamed app';
		} catch {
			// Not a URL; try the next one.
		}
	return 'Unnamed app';
}

// Tokens cannot list, create, or revoke tokens.
function sessionOnly(
	context: ApiContext,
	message = 'Manage tokens from the Flared app.'
): Extract<ApiPrincipal, { kind: 'session' }> {
	const { principal } = context.var;
	if (principal.kind !== 'session') throw new ApiError('INSUFFICIENT_SCOPE', message);
	return principal;
}

function ownerOnly(context: ApiContext, message: string): void {
	if (context.var.role !== 'owner') throw new ApiError('OWNER_REQUIRED', message);
}

// Changes to who belongs to a workspace must name the workspace the page shows, so a tab left on
// another workspace cannot make them here.
function requireShown(context: ApiContext): void {
	if (context.req.header(workspaceHeader) !== context.var.tenantId)
		throw new ApiError(
			'WORKSPACE_CHANGED',
			'You switched workspaces in another tab. Reload the page to continue.'
		);
}

function offerSummary(
	userId: string,
	email: string,
	name: string,
	expiresAt: number
): OwnershipOffer {
	return { userId, email, name, expiresAt: new Date(expiresAt).toISOString() };
}

function inviteSummary(
	id: string,
	email: string | null,
	createdAt: number,
	expiresAt: number
): WorkspaceInvite {
	return {
		id,
		email,
		createdAt: new Date(createdAt).toISOString(),
		expiresAt: new Date(expiresAt).toISOString()
	};
}

const isoOrNull = (time: number | null) => (time === null ? null : new Date(time).toISOString());

function endpointSummary(row: WebhookEndpointRow, secretChanged: boolean): WebhookEndpoint {
	return {
		id: row.id,
		url: row.url,
		events: row.events,
		milestoneInterval: row.milestoneInterval,
		enabled: row.enabled,
		pausedUntil: isoOrNull(row.pausedUntil),
		failureCount: row.failureCount,
		lastSuccessAt: isoOrNull(row.lastSuccessAt),
		lastFailureAt: isoOrNull(row.lastFailureAt),
		previousSecretUntil: isoOrNull(row.previousSecretUntil),
		secretChanged,
		createdAt: new Date(row.createdAt).toISOString(),
		updatedAt: new Date(row.updatedAt).toISOString()
	};
}

function deliverySummary(row: WebhookDeliveryRow): WebhookDelivery {
	return {
		id: row.id,
		eventId: row.eventId,
		eventType: row.eventType,
		state: row.state,
		attempts: row.attempts,
		responseStatus: row.responseStatus,
		errorCode: row.errorCode,
		durationMs: row.durationMs,
		createdAt: new Date(row.createdAt).toISOString(),
		lastAttemptAt: isoOrNull(row.lastAttemptAt),
		completedAt: isoOrNull(row.completedAt)
	};
}

const applyRefusals: Record<
	Exclude<LinkApplyOutcome, 'applied' | 'unchanged'>,
	NonNullable<ApplyAutomationLinkResult['error']>
> = {
	not_found: { code: 'NOT_FOUND', message: 'Link not found.' },
	blocked: {
		code: 'LINK_BLOCKED',
		message: 'Flared blocked this link for abuse. It takes no automations.'
	},
	link_limit: {
		code: 'LINK_AUTOMATION_LIMIT_REACHED',
		message: 'This link has 5 automations. Remove one from the link first.'
	},
	not_checkable: {
		code: 'INVALID_INPUT',
		message:
			'Flared cannot check this destination. It needs an http or https URL on the default port, on a public hostname that is not a Flared address.'
	}
};

function applyLinkResult(link: {
	linkId: string;
	outcome: LinkApplyOutcome;
}): ApplyAutomationLinkResult {
	if (link.outcome === 'applied' || link.outcome === 'unchanged')
		return { linkId: link.linkId, status: link.outcome };
	return { linkId: link.linkId, status: 'failed', error: { ...applyRefusals[link.outcome] } };
}

// A body that may be left out: no content type and no bytes is no body.
async function readOptionalJson(request: Request): Promise<unknown> {
	if (request.headers.get('content-type') !== null) return readJson(request);
	if ((await request.arrayBuffer()).byteLength > 0)
		throw new ApiError('UNSUPPORTED_MEDIA_TYPE', 'Send the body as application/json.');
	return undefined;
}

function methodNotAllowed(context: ApiContext, allow: string): Response {
	return failure('METHOD_NOT_ALLOWED', 'Method not allowed.', context.var.requestId, { allow });
}
