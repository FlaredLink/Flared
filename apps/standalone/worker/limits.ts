// SPDX-License-Identifier: AGPL-3.0-only
// /api/settings/limits: the owner reads and changes the workspace limits. A change needs the
// session cookie, the exact app Origin, and a sign-in from the last 10 minutes. It stores a new
// policy revision and projects it; the answer says whether both stores hold it yet.
import { readPolicyProjection, type PolicyLimits } from '@flared/data/tenancy';
import { sessionPrincipal } from '@flared/server/api/compose';
import { freshUntil } from '@flared/server/auth/session';
import { resolveTenant, updatePolicy } from '@flared/server/tenancy';
import type { AuthService } from '@flared/server/web';
import type { StandaloneConfig } from './config';

// Bounds of each limit. Higher values are possible on D1 and Queues but cost more; see
// docs/self-hosting/limits.md.
export const limitBounds: Record<keyof PolicyLimits, { min: number; max: number }> = {
	activeLinkLimit: { min: 1, max: 1_000_000 },
	monthlyClickLimit: { min: 1, max: 100_000_000 },
	retentionDays: { min: 1, max: 3650 },
	domainLimit: { min: 0, max: 50 }
};

function failure(code: string, status: number, message: string): Response {
	return Response.json(
		{ error: { code, message, requestId: crypto.randomUUID() } },
		{ status, headers: { 'cache-control': 'no-store' } }
	);
}

function parseLimits(value: unknown): PolicyLimits | null {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
	const keys = Object.keys(limitBounds);
	const entries = Object.entries(value);
	if (entries.length !== keys.length || entries.some(([key]) => !keys.includes(key))) return null;
	const record = Object.fromEntries(entries);
	const limits: Record<string, number> = {};
	for (const [key, bounds] of Object.entries(limitBounds)) {
		const number = record[key];
		if (
			typeof number !== 'number' ||
			!Number.isSafeInteger(number) ||
			number < bounds.min ||
			number > bounds.max
		)
			return null;
		limits[key] = number;
	}
	return {
		activeLinkLimit: limits.activeLinkLimit,
		monthlyClickLimit: limits.monthlyClickLimit,
		retentionDays: limits.retentionDays,
		domainLimit: limits.domainLimit
	};
}

async function view(config: StandaloneConfig, tenantId: string): Promise<Response> {
	const policy = await readPolicyProjection(config.identity, tenantId);
	if (!policy) return failure('SERVICE_UNAVAILABLE', 503, 'The limits are not available.');
	// D1 reports the database size with every result.
	const size = await config.shards[config.analyticsShardId]
		.prepare('SELECT 1')
		.run()
		.then((result) => result.meta.size_after)
		.catch(() => null);
	return Response.json(
		{
			limits: {
				activeLinkLimit: policy.activeLinkLimit,
				monthlyClickLimit: policy.monthlyClickLimit,
				retentionDays: policy.retentionDays,
				domainLimit: policy.domainLimit
			},
			pending:
				policy.routingRevision < policy.revision || policy.analyticsRevision < policy.revision,
			analyticsBytes: typeof size === 'number' ? size : null,
			bounds: limitBounds
		},
		{ headers: { 'cache-control': 'no-store' } }
	);
}

export async function handleLimits(
	request: Request,
	config: StandaloneConfig,
	auth: AuthService,
	fixedTenantId: string
): Promise<Response> {
	if (new URL(request.url).pathname !== '/api/settings/limits')
		return failure('NOT_FOUND', 404, 'Route not found.');
	if (request.method !== 'GET' && request.method !== 'POST')
		return failure('METHOD_NOT_ALLOWED', 405, 'Method not allowed.');
	if (request.method === 'POST' && request.headers.get('origin') !== config.origin)
		return failure('ORIGIN_REJECTED', 403, 'This request must come from the Flared app.');
	const principal = await sessionPrincipal(request, auth, config.origin);
	if (principal?.kind !== 'session') return failure('UNAUTHENTICATED', 401, 'Sign in to continue.');
	const tenant = await resolveTenant(config.identity, {
		userId: principal.userId,
		sessionId: principal.sessionId
	});
	if (tenant.status !== 'active' || tenant.tenantId !== fixedTenantId)
		return failure('NO_WORKSPACE', 403, 'Your account has no workspace.');
	if (request.method === 'GET') return view(config, tenant.tenantId);
	if (freshUntil(principal) === null)
		return failure('REAUTH_REQUIRED', 403, 'Confirm it’s you, then change the limits.');
	if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))
		return failure('UNSUPPORTED_MEDIA_TYPE', 415, 'Send the limits as JSON.');
	const text = await request.text();
	if (text.length > 1024) return failure('PAYLOAD_TOO_LARGE', 413, 'The request is too large.');
	let body: unknown = null;
	try {
		body = JSON.parse(text);
	} catch {
		// An unreadable body is invalid below.
	}
	const limits = parseLimits(body);
	if (!limits)
		return failure('VALIDATION_FAILED', 422, 'Each limit must be a whole number in range.');
	await updatePolicy(
		config.identity,
		{ routing: config.routing, analytics: config.shards },
		tenant.tenantId,
		limits,
		Date.now()
	);
	await config.identity
		.prepare(
			"INSERT INTO owner_audit (id, action, detail, created_at) VALUES (?, 'limits_changed', ?, ?)"
		)
		.bind(crypto.randomUUID(), JSON.stringify(limits), Date.now())
		.run();
	return view(config, tenant.tenantId);
}
