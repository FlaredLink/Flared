// SPDX-License-Identifier: AGPL-3.0-only
// POST /api/account/delete: the user deletes the account and every workspace they own.
// POST /api/workspace/delete: the owner deletes the workspace the page shows, and keeps the
// account. Each edition names the value typed to confirm an account deletion and may refuse a
// deletion for its own reasons.
import type { D1Database } from '@cloudflare/workers-types/index.ts';
import { workspaceHeader } from '@flared/contracts/workspace';
import { deleteMemberOnlyUser } from '@flared/data/deletions';
import { ownedWorkspacesWithMembers } from '@flared/data/members';
import { listWorkspaces } from '@flared/data/tenancy';
import type { ApiAuthentication, ApiPrincipal } from './api';
import { freshUntil } from './auth/session';
import { requestAccountDeletion, requestWorkspaceDeletion } from './deletion';
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
	| 'WORKSPACE_CHANGED'
	| 'LAST_WORKSPACE'
	| 'WORKSPACE_HAS_MEMBERS'
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
	WORKSPACE_CHANGED: 409,
	LAST_WORKSPACE: 409,
	WORKSPACE_HAS_MEMBERS: 409,
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

export interface DeletedWorkspace {
	id: string;
	name: string;
}

export interface AccountDeletionEdition {
	// The value the user types to confirm an account deletion, compared without case, or null
	// when the user has none. The cloud uses the account email.
	confirmation(identity: D1Database, userId: string): Promise<string | null>;
	// The message for a confirmation that does not match.
	mismatchMessage: string;
	// The message for a workspace the operator suspended.
	suspendedMessage(workspaceName: string): string;
	// An edition's own refusal before a workspace's deletion starts, such as a renewing
	// subscription. An account deletion asks for each workspace the user owns. It does not run
	// for a workspace that is already being deleted.
	refuse?(identity: D1Database, workspace: DeletedWorkspace): Promise<AccountRefusal | null>;
}

export interface AccountRouteOptions {
	identity: D1Database;
	appOrigin: string;
	authenticate(request: Request): Promise<ApiAuthentication>;
	// Starts a workspace's deletion job in the background right after the request.
	start(tenantId: string): void;
	edition: AccountDeletionEdition;
	now?: () => number;
}

type Checked =
	| {
			ok: true;
			principal: Extract<ApiPrincipal, { kind: 'session' }>;
			confirmation: string;
			now: number;
	  }
	| { ok: false; response: Response };

// Both routes need the session cookie, the exact app Origin, a sign-in from the last 10
// minutes, and a JSON confirmation.
async function checkRequest(
	request: Request,
	options: AccountRouteOptions,
	path: string,
	reauthMessage: string
): Promise<Checked> {
	const fail = (code: AccountErrorCode, message: string): Checked => ({
		ok: false,
		response: failure(code, message)
	});
	if (new URL(request.url).pathname !== path) return fail('NOT_FOUND', 'Route not found.');
	if (request.method !== 'POST') return fail('METHOD_NOT_ALLOWED', 'Method not allowed.');
	if (request.headers.get('origin') !== options.appOrigin)
		return fail('ORIGIN_REJECTED', 'This request must come from the Flared app.');
	const principal = await options.authenticate(request);
	if (principal?.kind !== 'session') return fail('UNAUTHENTICATED', 'Sign in to continue.');
	const now = (options.now ?? Date.now)();
	if (freshUntil(principal, now) === null) return fail('REAUTH_REQUIRED', reauthMessage);
	const body = await readConfirmation(request);
	if (!body.ok) return fail(body.code, 'Send the confirmation as JSON.');
	return { ok: true, principal, confirmation: body.value, now };
}

function accepted(): Response {
	return Response.json(
		{ status: 'deleting' },
		{ status: 202, headers: { 'cache-control': 'no-store' } }
	);
}

// Deletes every workspace the user owns, then the user. Answers 202 and starts the jobs at once.
export async function deleteAccount(
	request: Request,
	options: AccountRouteOptions
): Promise<Response> {
	const { identity, edition } = options;
	const checked = await checkRequest(
		request,
		options,
		'/api/account/delete',
		'Confirm it’s you, then delete your account.'
	);
	if (!checked.ok) return checked.response;
	const { principal, confirmation, now } = checked;

	const workspaces = await listWorkspaces(identity, principal.userId);
	if (workspaces.length === 0) return failure('NO_WORKSPACE', 'Your account has no workspace.');
	const owned = workspaces.filter((workspace) => workspace.role === 'owner');
	const expected = await edition.confirmation(identity, principal.userId);
	if (expected === null)
		return failure('OWNER_REQUIRED', 'Only the workspace owner can delete it.');
	if (confirmation.toLowerCase() !== expected.toLowerCase())
		return failure('CONFIRMATION_MISMATCH', edition.mismatchMessage);
	// A person who only belongs to other owners' workspaces has no workspace to delete: the
	// account goes at once, and those workspaces stay.
	if (owned.length === 0) {
		if (!(await deleteMemberOnlyUser(identity, principal.userId, now)))
			return failure('NO_WORKSPACE', 'Your account has no workspace.');
		return accepted();
	}
	// Members would lose a workspace they use. The owner makes a member the owner, removes the
	// members, or deletes that workspace.
	const shared = await ownedWorkspacesWithMembers(identity, principal.userId);
	if (shared.length > 0)
		return failure(
			'WORKSPACE_HAS_MEMBERS',
			`${shared.map((name) => `“${name}”`).join(', ')} ${shared.length === 1 ? 'has' : 'have'} other members. In Settings, make a member the owner or remove the members, or delete ${shared.length === 1 ? 'that workspace' : 'those workspaces'}, before you delete your account.`
		);
	for (const workspace of owned) {
		if (workspace.status === 'suspended')
			return failure('WORKSPACE_SUSPENDED', edition.suspendedMessage(workspace.name));
		if (workspace.status === 'deleting' || !edition.refuse) continue;
		const refusal = await edition.refuse(identity, { id: workspace.id, name: workspace.name });
		if (refusal) return refuse(refusal);
	}

	const result = await requestAccountDeletion(identity, { userId: principal.userId }, now);
	if (result.status === 'no_workspace')
		return failure('NO_WORKSPACE', 'Your account has no workspace.');
	if (result.status === 'suspended')
		return failure('WORKSPACE_SUSPENDED', edition.suspendedMessage(result.workspaceName));
	for (const tenantId of result.tenantIds) options.start(tenantId);
	return accepted();
}

// Deletes the workspace the page shows; the account and the other workspaces stay. The page
// names the workspace in the X-Flared-Workspace header, and the owner types its name. Answers
// 202 and starts the job at once.
export async function deleteWorkspace(
	request: Request,
	options: AccountRouteOptions
): Promise<Response> {
	const { identity, edition } = options;
	const checked = await checkRequest(
		request,
		options,
		'/api/workspace/delete',
		'Confirm it’s you, then delete the workspace.'
	);
	if (!checked.ok) return checked.response;
	const { principal, confirmation, now } = checked;

	const tenant = await resolveTenant(identity, {
		userId: principal.userId,
		sessionId: principal.sessionId
	});
	if (tenant.status === 'none') return failure('NO_WORKSPACE', 'Your account has no workspace.');
	// A tab left on another workspace must not delete the one this session switched to.
	if (request.headers.get(workspaceHeader) !== tenant.tenantId)
		return failure(
			'WORKSPACE_CHANGED',
			'You switched workspaces in another tab. Reload the page to continue.'
		);
	if (tenant.role !== 'owner')
		return failure('OWNER_REQUIRED', 'Only the workspace owner can delete it.');
	const workspace = (await listWorkspaces(identity, principal.userId)).find(
		(item) => item.id === tenant.tenantId
	);
	if (!workspace) return failure('NO_WORKSPACE', 'Your account has no workspace.');
	if (confirmation.toLowerCase() !== workspace.name.toLowerCase())
		return failure('CONFIRMATION_MISMATCH', 'Type the workspace name exactly to confirm.');
	if (tenant.status !== 'deleting' && edition.refuse) {
		const refusal = await edition.refuse(identity, { id: workspace.id, name: workspace.name });
		if (refusal) return refuse(refusal);
	}

	const result = await requestWorkspaceDeletion(
		identity,
		{ userId: principal.userId, tenantId: tenant.tenantId, workspaceName: workspace.name },
		now
	);
	if (result.status === 'no_workspace')
		return failure('NO_WORKSPACE', 'Your account has no workspace.');
	if (result.status === 'suspended')
		return failure('WORKSPACE_SUSPENDED', edition.suspendedMessage(workspace.name));
	if (result.status === 'last_workspace')
		return failure(
			'LAST_WORKSPACE',
			'This is your only workspace. To remove it, delete your account.'
		);
	options.start(result.tenantId);
	return accepted();
}
