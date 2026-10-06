// SPDX-License-Identifier: AGPL-3.0-only
// The product API at /v1. Applications supply the principal: a dashboard session or an API
// token. The tenant always comes from the principal's stored membership.
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
import {
	LinkInputError,
	parseCreateLink,
	parseIdempotencyKey,
	parseUpdateLink
} from '@flared/contracts/links';
import {
	isTokenScope,
	parseCreateToken,
	tokenScopes,
	type ApiIdentity,
	type ApiTokenIdentity,
	type ApiTokenPage,
	type TokenScope
} from '@flared/contracts/tokens';
import { openApiDocument } from '@flared/contracts/openapi';
import { parseAddDomain } from '@flared/contracts/domains';
import { defaultQrSize, maxQrSize, minQrSize, qrPng, qrSvg } from '@flared/client/qr';
import type { ConnectedApp, ConnectedAppPage } from '@flared/contracts/oauth';
import { deleteGrant, listGrants } from '@flared/data/oauth';
import { countCreationAttempt } from '@flared/data/links';
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
import { resolveTenant } from './tenancy';
import {
	addDomain,
	checkDomain,
	getDomain,
	listDomainPage,
	removeDomain,
	type DomainSettings
} from './domains';
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
	| { kind: 'session'; userId: string; signedInAt: string }
	| {
			kind: 'token';
			userId: string;
			tenantId: string;
			scopes: readonly TokenScope[];
			token: ApiTokenIdentity;
	  }
	// An app connected through OAuth, such as an assistant calling the MCP endpoint in process.
	| {
			kind: 'oauth';
			userId: string;
			tenantId: string;
			scopes: readonly TokenScope[];
			clientId: string;
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
	// Creates API tokens. Without it, token creation answers 503.
	tokenAuth?: ApiTokenAuth;
	// The public URL of this API from deployment configuration, such as
	// https://api.flared.page/v1. With it, GET /v1/openapi.json serves the API description.
	publicApiUrl?: string;
	// Custom domains. Without a provider, domains are listed but cannot be added.
	domains?: DomainSettings;
	now?: () => number;
	creationsPerMinute?: number;
}

// Reads "Authorization: Bearer <token>" only. Applications that accept tokens use this as
// their authenticate function; cookies on the same request are ignored.
export async function authenticateBearer(
	tokenAuth: ApiTokenAuth,
	identity: D1Database,
	request: Request
): Promise<ApiAuthentication> {
	const match = /^Bearer +(\S+)$/i.exec(request.headers.get('authorization') ?? '');
	if (!match) return null;
	const result = await verifyToken(tokenAuth, identity, match[1]);
	if (result.status === 'valid') return { kind: 'token', ...result.principal };
	if (result.status === 'rate_limited')
		return { kind: 'rate_limited', retryAfterSeconds: result.retryAfterSeconds };
	return null;
}

const maxBodyBytes = 8192;

type Variables = { requestId: string; tenantId: string; principal: ApiPrincipal };
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

async function readJson(request: Request): Promise<unknown> {
	if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))
		throw new ApiError('UNSUPPORTED_MEDIA_TYPE', 'Send the body as application/json.');
	const declared = Number(request.headers.get('content-length') ?? '0');
	if (declared > maxBodyBytes) throw new ApiError('PAYLOAD_TOO_LARGE', 'The body is too large.');
	const bytes = await request.arrayBuffer();
	if (bytes.byteLength > maxBodyBytes)
		throw new ApiError('PAYLOAD_TOO_LARGE', 'The body is too large.');
	try {
		return JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		throw new ApiError('INVALID_INPUT', 'Send valid JSON.');
	}
}

function pageSize(value: string | undefined): number {
	if (value === undefined) return 50;
	const size = Number(value);
	if (!Number.isInteger(size) || size < 1 || size > 100)
		throw new ApiError('INVALID_INPUT', 'Use a limit from 1 to 100.');
	return size;
}

function search(value: string | undefined): string | null {
	if (value === undefined || !value.trim()) return null;
	if (value.length > 100)
		throw new ApiError('INVALID_INPUT', 'Use a search of at most 100 characters.');
	return value.trim();
}

export function createApi(dependencies: ApiDependencies): Hono<{ Variables: Variables }> {
	const { identity, routing, appOrigin } = dependencies;
	const now = dependencies.now ?? Date.now;
	const creationsPerMinute = dependencies.creationsPerMinute ?? 60;
	const domainSettings: DomainSettings = dependencies.domains ?? { reservedHostnames: [] };
	const app = new Hono<{ Variables: Variables }>().basePath('/v1');

	app.onError((error, context) => {
		const requestId = context.get('requestId') ?? crypto.randomUUID();
		if (error instanceof ApiError)
			return failure(
				error.code,
				error.message,
				requestId,
				error.retryAfterSeconds ? { 'retry-after': String(error.retryAfterSeconds) } : {}
			);
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
		const tenant = await resolveTenant(identity, principal.userId);
		// A token works only while its user still belongs to the token's workspace.
		if (
			principal.kind !== 'session' &&
			(tenant.status !== 'active' || tenant.tenantId !== principal.tenantId)
		)
			throw new ApiError('UNAUTHENTICATED', 'Sign in to continue.');
		if (tenant.status === 'none')
			throw new ApiError('NO_WORKSPACE', 'Your account has no workspace.');
		if (tenant.status === 'pending')
			throw new ApiError(
				'WORKSPACE_PENDING',
				'Your workspace is still being set up. Try again.',
				30
			);
		if (tenant.status === 'deleting')
			throw new ApiError('ACCOUNT_DELETING', 'This account is being deleted.');
		context.set('tenantId', tenant.tenantId);
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
		const result = await createLink(routing, { tenantId, key, input, requestId, now: time });
		if (result.status === 201 && !result.replayed)
			await noteLimitUsage(identity, routing, tenantId, time);
		return respond(result);
	});

	app.get('/links', requireScope('links:read'), async (context) => {
		const { tenantId } = context.var;
		const page = await listLinks(
			routing,
			tenantId,
			{
				limit: pageSize(context.req.query('limit')),
				cursor: context.req.query('cursor') ?? null,
				search: search(context.req.query('q'))
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
		const change = parseUpdateLink(await readJson(context.req.raw));
		const link = await changeLink(
			routing,
			context.var.tenantId,
			context.req.param('id'),
			change,
			now()
		);
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
			context.req.query('cursor') ?? null
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
	app.get('/me', (context) => {
		const { principal } = context.var;
		if (principal.kind === 'oauth')
			throw new ApiError('INSUFFICIENT_SCOPE', 'Connected apps cannot read this.');
		const identity: ApiIdentity =
			principal.kind === 'token'
				? { kind: 'token', scopes: [...principal.scopes], token: principal.token }
				: { kind: 'session', scopes: [...tokenScopes] };
		return respond({ status: 200, body: JSON.stringify(identity) });
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
		console.log(JSON.stringify({ event: 'oauth_grant_revoked', requestId }));
		return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
	});

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
	app.all('/tokens', (context) => methodNotAllowed(context, 'GET, POST'));
	app.all('/tokens/:id', (context) => methodNotAllowed(context, 'DELETE'));
	app.all('/connected-apps', (context) => methodNotAllowed(context, 'GET'));
	app.all('/connected-apps/:clientId', (context) => methodNotAllowed(context, 'DELETE'));
	return app;
}

// A session holds every scope; a token or connected app must hold the route's scope.
function requireScope(scope: TokenScope): MiddlewareHandler<{ Variables: Variables }> {
	return async (context, next) => {
		const { principal } = context.var;
		if (principal.kind !== 'session' && !principal.scopes.includes(scope))
			throw new ApiError('INSUFFICIENT_SCOPE', `This token needs the ${scope} scope.`);
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
function sessionOnly(context: ApiContext): Extract<ApiPrincipal, { kind: 'session' }> {
	const { principal } = context.var;
	if (principal.kind !== 'session')
		throw new ApiError('INSUFFICIENT_SCOPE', 'Manage tokens from the Flared app.');
	return principal;
}

function methodNotAllowed(context: ApiContext, allow: string): Response {
	return failure('METHOD_NOT_ALLOWED', 'Method not allowed.', context.var.requestId, { allow });
}
