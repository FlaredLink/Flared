// SPDX-License-Identifier: AGPL-3.0-only
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
