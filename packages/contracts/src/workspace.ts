// SPDX-License-Identifier: AGPL-3.0-only
// The workspace's display name: the sidebar tile and Settings show it, and its owner renames it.
import { LinkInputError } from './links';

export interface Workspace {
	name: string;
}

export const workspaceNameMaxLength = 60;

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

export function parseRenameWorkspace(body: unknown): Workspace {
	if (!isRecord(body)) throw new LinkInputError('body', 'Send a JSON object.');
	for (const key of Object.keys(body))
		if (key !== 'name') throw new LinkInputError(key, `Unknown field: ${key}.`);
	const name = normalizeWorkspaceName(body.name);
	if (name === null)
		throw new LinkInputError('name', `Use a name of 1 to ${workspaceNameMaxLength} characters.`);
	return { name };
}

export function isWorkspace(value: unknown): value is Workspace {
	return isRecord(value) && typeof value.name === 'string';
}
