// SPDX-License-Identifier: AGPL-3.0-only
// The workspace's display name, which the sidebar tile and Settings show and its owner renames,
// and the choice of a session's active workspace.
import { LinkInputError } from './links';

export type WorkspaceRole = 'owner' | 'member';

// The session's active workspace.
export interface Workspace {
	id: string;
	name: string;
	role: WorkspaceRole;
}

// pending: still being set up. deleting: its deletion has started.
export type WorkspaceStatus = 'active' | 'pending' | 'suspended' | 'deleting';

export interface WorkspaceSummary extends Workspace {
	status: WorkspaceStatus;
}

// Every workspace of the signed-in user, oldest first, and the session's active one.
export interface WorkspaceList {
	workspaces: WorkspaceSummary[];
	activeId: string | null;
}

export const workspaceNameMaxLength = 60;

// The dashboard sends the ID of the workspace a page shows with each change. The API refuses the
// change with WORKSPACE_CHANGED when the session has since switched to another workspace.
export const workspaceHeader = 'x-flared-workspace';
// The same ID in a server-rendered form, which cannot send headers.
export const workspaceField = 'workspace';

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Trimmed, with each run of whitespace (line breaks too) made one space: 1 to 60 characters and
// no control characters.
export function normalizeWorkspaceName(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const name = value.trim().replace(/\s+/g, ' ');
	if (name.length === 0 || [...name].length > workspaceNameMaxLength) return null;
	if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(name)) return null;
	return name;
}

export function parseRenameWorkspace(body: unknown): { name: string } {
	if (!isRecord(body)) throw new LinkInputError('body', 'Send a JSON object.');
	for (const key of Object.keys(body))
		if (key !== 'name') throw new LinkInputError(key, `Unknown field: ${key}.`);
	const name = normalizeWorkspaceName(body.name);
	if (name === null)
		throw new LinkInputError('name', `Use a name of 1 to ${workspaceNameMaxLength} characters.`);
	return { name };
}

// The body of POST /v1/workspaces/active. The server checks the membership; the ID alone grants
// nothing.
export function parseSelectWorkspace(body: unknown): { tenantId: string } {
	if (!isRecord(body)) throw new LinkInputError('body', 'Send a JSON object.');
	for (const key of Object.keys(body))
		if (key !== 'tenantId') throw new LinkInputError(key, `Unknown field: ${key}.`);
	const { tenantId } = body;
	if (typeof tenantId !== 'string' || tenantId.length === 0 || tenantId.length > 64)
		throw new LinkInputError('tenantId', 'Send the ID of one of your workspaces.');
	return { tenantId };
}

const roles: readonly string[] = ['owner', 'member'] satisfies WorkspaceRole[];
const statuses: readonly string[] = [
	'active',
	'pending',
	'suspended',
	'deleting'
] satisfies WorkspaceStatus[];

export function isWorkspace(value: unknown): value is Workspace {
	return (
		isRecord(value) &&
		typeof value.id === 'string' &&
		typeof value.name === 'string' &&
		typeof value.role === 'string' &&
		roles.includes(value.role)
	);
}

export function isWorkspaceList(value: unknown): value is WorkspaceList {
	return (
		isRecord(value) &&
		Array.isArray(value.workspaces) &&
		value.workspaces.every(
			(item: unknown) =>
				isWorkspace(item) &&
				isRecord(item) &&
				typeof item.status === 'string' &&
				statuses.includes(item.status)
		) &&
		(value.activeId === null || typeof value.activeId === 'string')
	);
}
