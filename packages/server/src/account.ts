// SPDX-License-Identifier: AGPL-3.0-only
// POST /api/account/delete: the owner deletes the account and its workspace. Each edition
// names the value the owner types to confirm and may refuse a deletion for its own reasons.
import type { D1Database } from '@cloudflare/workers-types/index.ts';
import type { ApiAuthentication } from './api';
import { freshUntil } from './auth/session';
import { requestDeletion } from './deletion';
import { resolveTenant } from './tenancy';

const maxBodyBytes = 1024;

type AccountErrorCode =
	| 'UNAUTHENTICATED'
	| 'ORIGIN_REJECTED'
	| 'REAUTH_REQUIRED'
	| 'NO_WORKSPACE'
	| 'OWNER_REQUIRED'
	| 'CONFIRMATION_MISMATCH'
	| 'WORKSPACE_SUSPENDED'
	| 'UNSUPPORTED_MEDIA_TYPE'
	| 'PAYLOAD_TOO_LARGE'
	| 'METHOD_NOT_ALLOWED'
	| 'NOT_FOUND';

const statuses: Record<AccountErrorCode, number> = {
	UNAUTHENTICATED: 401,
	ORIGIN_REJECTED: 403,
	REAUTH_REQUIRED: 403,
	NO_WORKSPACE: 403,
	OWNER_REQUIRED: 403,
	CONFIRMATION_MISMATCH: 422,
	WORKSPACE_SUSPENDED: 409,
	UNSUPPORTED_MEDIA_TYPE: 415,
	PAYLOAD_TOO_LARGE: 413,
	METHOD_NOT_ALLOWED: 405,
	NOT_FOUND: 404
};

export interface AccountRefusal {
	code: string;
	status: number;
	message: string;
}

function refuse({ code, status, message }: AccountRefusal): Response {
	return Response.json(
		{ error: { code, message, requestId: crypto.randomUUID() } },
		{ status, headers: { 'cache-control': 'no-store' } }
	);
}

function failure(code: AccountErrorCode, message: string): Response {
	return refuse({ code, status: statuses[code], message });
}

async function readConfirmation(
	request: Request
): Promise<{ ok: true; value: string } | { ok: false; code: AccountErrorCode }> {
	if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))
		return { ok: false, code: 'UNSUPPORTED_MEDIA_TYPE' };
	const tooLarge = { ok: false, code: 'PAYLOAD_TOO_LARGE' } as const;
	if (Number(request.headers.get('content-length') ?? 0) > maxBodyBytes) return tooLarge;
	const text = await request.text();
	if (text.length > maxBodyBytes) return tooLarge;
	try {
		const body: unknown = JSON.parse(text);
		if (typeof body === 'object' && body !== null && 'confirmation' in body) {
			const value = body.confirmation;
			if (typeof value === 'string') return { ok: true, value: value.trim() };
		}
	} catch {
		// An unreadable body confirms nothing.
	}
	return { ok: true, value: '' };
}

export interface AccountDeletionEdition {
	// The value the owner types to confirm, compared without case, or null when the user has
	// none. The cloud uses the account email.
	confirmation(identity: D1Database, userId: string): Promise<string | null>;
	// The message for a confirmation that does not match.
	mismatchMessage: string;
	// The message for a workspace the operator suspended.
	suspendedMessage: string;
	// An edition's own refusal before a deletion starts, such as a renewing subscription.
	// It does not run again while a deletion is already in progress.
	refuse?(identity: D1Database, tenantId: string): Promise<AccountRefusal | null>;
}

export interface AccountRouteOptions {
	identity: D1Database;
	appOrigin: string;
	authenticate(request: Request): Promise<ApiAuthentication>;
	// Starts the deletion job in the background right after the request.
	start(tenantId: string): void;
	edition: AccountDeletionEdition;
	now?: () => number;
}

// Needs the session cookie, the exact app Origin, a sign-in from the last 10 minutes, the
// workspace owner, and the typed confirmation. Answers 202 and starts the job at once.
export async function deleteAccount(
	request: Request,
	options: AccountRouteOptions
): Promise<Response> {
	const { identity, edition } = options;
	const url = new URL(request.url);
	if (url.pathname !== '/api/account/delete') return failure('NOT_FOUND', 'Route not found.');
	if (request.method !== 'POST') return failure('METHOD_NOT_ALLOWED', 'Method not allowed.');
	if (request.headers.get('origin') !== options.appOrigin)
		return failure('ORIGIN_REJECTED', 'This request must come from the Flared app.');
	const principal = await options.authenticate(request);
	if (principal?.kind !== 'session') return failure('UNAUTHENTICATED', 'Sign in to continue.');
	const now = (options.now ?? Date.now)();
	if (freshUntil(principal, now) === null)
		return failure('REAUTH_REQUIRED', 'Confirm it’s you, then delete your account.');
	const body = await readConfirmation(request);
	if (!body.ok) return failure(body.code, 'Send the confirmation as JSON.');
	const confirmation = body.value;

	const tenant = await resolveTenant(identity, {
		userId: principal.userId,
		sessionId: principal.sessionId
	});
	if (tenant.status === 'none') return failure('NO_WORKSPACE', 'Your account has no workspace.');
	const expected =
		tenant.role === 'owner' ? await edition.confirmation(identity, principal.userId) : null;
	if (expected === null)
		return failure('OWNER_REQUIRED', 'Only the workspace owner can delete it.');
	if (confirmation.toLowerCase() !== expected.toLowerCase())
		return failure('CONFIRMATION_MISMATCH', edition.mismatchMessage);
	if (tenant.status !== 'deleting' && edition.refuse) {
		const refusal = await edition.refuse(identity, tenant.tenantId);
		if (refusal) return refuse(refusal);
	}

	const result = await requestDeletion(
		identity,
		{ userId: principal.userId, tenantId: tenant.tenantId },
		now
	);
	if (result.status === 'no_workspace')
		return failure('NO_WORKSPACE', 'Your account has no workspace.');
	if (result.status === 'suspended')
		return failure('WORKSPACE_SUSPENDED', edition.suspendedMessage);
	options.start(result.tenantId);
	return Response.json(
		{ status: 'deleting' },
		{ status: 202, headers: { 'cache-control': 'no-store' } }
	);
}
