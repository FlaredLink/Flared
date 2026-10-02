// SPDX-License-Identifier: AGPL-3.0-only
// The product API at /v1. Applications supply the principal; the tenant always comes from
// the principal's stored membership.
import type { D1Database } from '@cloudflare/workers-types/index.ts';
import { Hono, type Context } from 'hono';
import type { ErrorCode } from '@flared/contracts/errors';
import {
	LinkInputError,
	parseCreateLink,
	parseIdempotencyKey,
	parseUpdateLink
} from '@flared/contracts/links';
import { countCreationAttempt } from '@flared/data/links';
import { resolveTenant } from './tenancy';
import {
	ApiError,
	changeLink,
	createLink,
	errorBody,
	getLink,
	listLinks,
	statusOf,
	type ApiResult
} from './links';

export interface ApiDependencies {
	identity: D1Database;
	routing: D1Database;
	// The exact application origin from deployment configuration.
	appOrigin: string;
	// Returns the signed-in user's ID, or null when the request carries no valid session.
	authenticate(request: Request): Promise<string | null>;
	now?: () => number;
	creationsPerMinute?: number;
}

const maxBodyBytes = 8192;

type Variables = { requestId: string; tenantId: string };

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
		console.error(JSON.stringify({ event: 'api_failed', requestId }));
		return failure('SERVICE_UNAVAILABLE', 'The service is not available. Try again.', requestId);
	});
	app.notFound((context) =>
		failure('NOT_FOUND', 'Route not found.', context.get('requestId') ?? crypto.randomUUID())
	);

	app.use('*', async (context, next) => {
		context.set('requestId', crypto.randomUUID());
		const method = context.req.method;
		// Cookie-authenticated mutations need the exact application origin.
		if (method !== 'GET' && method !== 'HEAD' && context.req.header('origin') !== appOrigin)
			throw new ApiError('ORIGIN_REJECTED', 'This request must come from the Flared app.');
		const userId = await dependencies.authenticate(context.req.raw);
		if (!userId) throw new ApiError('UNAUTHENTICATED', 'Sign in to continue.');
		const tenant = await resolveTenant(identity, userId);
		if (tenant.status === 'none')
			throw new ApiError('NO_WORKSPACE', 'Your account has no workspace.');
		if (tenant.status === 'pending')
			throw new ApiError(
				'WORKSPACE_PENDING',
				'Your workspace is still being set up. Try again.',
				30
			);
		context.set('tenantId', tenant.tenantId);
		await next();
	});

	app.post('/links', async (context) => {
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
		return respond(await createLink(routing, { tenantId, key, input, requestId, now: time }));
	});

	app.get('/links', async (context) => {
		const page = await listLinks(routing, context.var.tenantId, {
			limit: pageSize(context.req.query('limit')),
			cursor: context.req.query('cursor') ?? null,
			search: search(context.req.query('q'))
		});
		return respond({ status: 200, body: JSON.stringify(page) });
	});

	app.get('/links/:id', async (context) => {
		const link = await getLink(routing, context.var.tenantId, context.req.param('id'));
		return respond({ status: 200, body: JSON.stringify({ link }) });
	});

	app.patch('/links/:id', async (context) => {
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

	app.all('/links', (context) => methodNotAllowed(context, 'GET, POST'));
	app.all('/links/:id', (context) => methodNotAllowed(context, 'GET, PATCH'));
	return app;
}

function methodNotAllowed(context: Context<{ Variables: Variables }>, allow: string): Response {
	return failure('METHOD_NOT_ALLOWED', 'Method not allowed.', context.var.requestId, { allow });
}
