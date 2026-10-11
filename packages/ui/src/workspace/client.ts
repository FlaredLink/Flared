// SPDX-License-Identifier: AGPL-3.0-only
import {
	isAcceptedInvite,
	isInvitePreview,
	type AcceptedInvite,
	type InvitePreview
} from '@flared/contracts/members';
import { isWorkspace, type WorkspaceSummary } from '@flared/contracts/workspace';

// Makes another of the person's workspaces the active one for this sign-in.
export async function selectWorkspace(apiBase: string, tenantId: string): Promise<boolean> {
	try {
		const response = await fetch(`${apiBase}/workspaces/active`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ tenantId })
		});
		return response.status === 204;
	} catch {
		return false;
	}
}

export type CreatedWorkspace =
	| { ok: true; workspace: Pick<WorkspaceSummary, 'id' | 'name'>; active: boolean }
	| { ok: false; message: string };

const createFailed = 'We could not create the workspace. Try again.';

// Creates a workspace that the person owns. On success it is the session's active workspace,
// unless active is false.
export async function createWorkspace(apiBase: string, name: string): Promise<CreatedWorkspace> {
	try {
		const response = await fetch(`${apiBase}/workspaces`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ name })
		});
		const body: unknown = await response.json().catch(() => null);
		const record = typeof body === 'object' && body !== null ? body : {};
		if (response.status === 201) {
			const workspace: unknown = Reflect.get(record, 'workspace');
			const active: unknown = Reflect.get(record, 'active');
			return isWorkspace(workspace) && typeof active === 'boolean'
				? { ok: true, workspace: { id: workspace.id, name: workspace.name }, active }
				: { ok: false, message: createFailed };
		}
		const error: unknown = Reflect.get(record, 'error');
		const code = typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : null;
		const message =
			typeof error === 'object' && error !== null ? Reflect.get(error, 'message') : null;
		// These messages are written for the person: what to change, or why no workspace opens.
		if (
			(code === 'WORKSPACE_LIMIT_REACHED' ||
				code === 'INVALID_INPUT' ||
				code === 'SERVICE_UNAVAILABLE') &&
			typeof message === 'string'
		)
			return { ok: false, message };
		if (code === 'RATE_LIMITED')
			return { ok: false, message: 'Too many requests. Try again soon.' };
		return { ok: false, message: createFailed };
	} catch {
		return { ok: false, message: createFailed };
	}
}

export type InviteOutcome = { ok: true; emailSent: boolean } | { ok: false; message: string };

function errorOf(body: unknown): { code: unknown; message: unknown } {
	const error = typeof body === 'object' && body !== null ? Reflect.get(body, 'error') : null;
	return typeof error === 'object' && error !== null
		? { code: Reflect.get(error, 'code'), message: Reflect.get(error, 'message') }
		: { code: null, message: null };
}

// Messages the API writes for the owner: what to change before the invite can go out.
const inviteCodes = new Set([
	'INVALID_INPUT',
	'ALREADY_MEMBER',
	'INVITE_PENDING',
	'MEMBER_LIMIT_REACHED',
	'RATE_LIMITED',
	'OWNER_REQUIRED',
	'WORKSPACE_CHANGED',
	'WORKSPACE_SUSPENDED'
]);

// Sends an invite, or sends one again with a new link when id is set.
export async function sendInvite(
	apiBase: string,
	target: { email: string } | { id: string },
	workspace: Record<string, string>
): Promise<InviteOutcome> {
	const failed = 'We could not send the invite. Try again.';
	try {
		const response =
			'id' in target
				? await fetch(`${apiBase}/invites/${encodeURIComponent(target.id)}/resend`, {
						method: 'POST',
						headers: workspace
					})
				: await fetch(`${apiBase}/invites`, {
						method: 'POST',
						headers: { 'content-type': 'application/json', ...workspace },
						body: JSON.stringify({ email: target.email })
					});
		const body: unknown = await response.json().catch(() => null);
		if (response.ok) {
			const emailSent: unknown =
				typeof body === 'object' && body !== null ? Reflect.get(body, 'emailSent') : null;
			return { ok: true, emailSent: emailSent === true };
		}
		const { code, message } = errorOf(body);
		return {
			ok: false,
			message:
				typeof code === 'string' && inviteCodes.has(code) && typeof message === 'string'
					? message
					: failed
		};
	} catch {
		return { ok: false, message: failed };
	}
}

export async function cancelInvite(
	apiBase: string,
	id: string,
	workspace: Record<string, string>
): Promise<boolean> {
	try {
		const response = await fetch(`${apiBase}/invites/${encodeURIComponent(id)}`, {
			method: 'DELETE',
			headers: workspace
		});
		return response.status === 204 || response.status === 404;
	} catch {
		return false;
	}
}

export type InviteLookup =
	{ ok: true; preview: InvitePreview } | { ok: false; ended: boolean; message: string };

const ended = 'This invite has ended or was already used. Ask the workspace owner for a new one.';

// What the invite link opens: the workspace and the address it is for.
export async function lookupInvite(apiBase: string, token: string): Promise<InviteLookup> {
	try {
		const response = await fetch(`${apiBase}/invites/lookup`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ token })
		});
		const body: unknown = await response.json().catch(() => null);
		if (response.ok && isInvitePreview(body)) return { ok: true, preview: body };
		const { code } = errorOf(body);
		if (code === 'NOT_FOUND' || code === 'INVALID_INPUT')
			return { ok: false, ended: true, message: ended };
		return { ok: false, ended: false, message: 'We could not open the invite. Try again.' };
	} catch {
		return { ok: false, ended: false, message: 'We could not open the invite. Try again.' };
	}
}

export type InviteAcceptance =
	{ ok: true; accepted: AcceptedInvite } | { ok: false; message: string };

export async function acceptInvite(apiBase: string, token: string): Promise<InviteAcceptance> {
	const failed = 'We could not accept the invite. Try again.';
	try {
		const response = await fetch(`${apiBase}/invites/accept`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ token })
		});
		const body: unknown = await response.json().catch(() => null);
		if (response.ok && isAcceptedInvite(body)) return { ok: true, accepted: body };
		const { code, message } = errorOf(body);
		if (code === 'NOT_FOUND') return { ok: false, message: ended };
		if (
			(code === 'INVITE_FOR_ANOTHER_EMAIL' || code === 'ACCOUNT_DELETING') &&
			typeof message === 'string'
		)
			return { ok: false, message };
		return { ok: false, message: failed };
	} catch {
		return { ok: false, message: failed };
	}
}
