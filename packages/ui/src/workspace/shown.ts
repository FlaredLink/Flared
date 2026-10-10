// SPDX-License-Identifier: AGPL-3.0-only
// The workspace a page shows. Each change the page sends names it, so the API refuses a change
// from a tab left on a workspace that another tab has since switched away from. A context, not
// module state: a server-rendered page must never see another request's workspace.
import { getContext, setContext } from 'svelte';
import { workspaceHeader } from '@flared/contracts/workspace';

const key = Symbol('shown workspace');

// The app layout provides the ID of the workspace it rendered. Without it, changes name none.
export function provideShownWorkspace(id: () => string | null): void {
	setContext(key, id);
}

// Call while a component initializes. Returns the ID of the workspace the page shows.
export function shownWorkspaceId(): () => string | null {
	const id = getContext<(() => string | null) | undefined>(key);
	return () => id?.() ?? null;
}

// Call while a component initializes. Returns the headers that name the shown workspace.
export function shownWorkspace(): () => Record<string, string> {
	const id = shownWorkspaceId();
	return () => {
		const value = id();
		const headers: Record<string, string> = {};
		if (value) headers[workspaceHeader] = value;
		return headers;
	};
}
