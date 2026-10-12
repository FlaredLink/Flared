// SPDX-License-Identifier: AGPL-3.0-only
import { redirect } from '@sveltejs/kit';
import type { Usage } from '@flared/contracts/analytics';
import type { Workspace } from '@flared/contracts/workspace';
import { getAuthState, type AuthState } from '@flared/server/web/auth';
import { fetchUsage, fetchWorkspace } from '@flared/server/web/api';
import { appRoutes } from '$lib/routes';
import type { LayoutServerLoad } from './$types';

async function loadUsage(
	platform: App.Platform | undefined,
	headers: Headers
): Promise<Usage | null> {
	const service = platform?.env.API_SERVICE;
	if (!service) return null;
	try {
		const result = await fetchUsage(service, headers);
		return result.ok ? result.usage : null;
	} catch {
		console.error(JSON.stringify({ event: 'usage_unavailable' }));
		return null;
	}
}

async function loadWorkspace(
	platform: App.Platform | undefined,
	headers: Headers
): Promise<Workspace | null> {
	const service = platform?.env.API_SERVICE;
	if (!service) return null;
	try {
		const result = await fetchWorkspace(service, headers);
		return result.ok ? result.workspace : null;
	} catch {
		console.error(JSON.stringify({ event: 'workspace_unavailable' }));
		return null;
	}
}

export const load: LayoutServerLoad = async ({ parent, platform, request, url }) => {
	const { installation } = await parent();
	if (installation.state === 'unclaimed' || installation.state === 'initializing')
		redirect(303, appRoutes.setup);
	const service = platform?.env.AUTH_SERVICE;
	const auth: AuthState = service
		? await getAuthState(service, request.headers, url.origin)
		: { status: 'unavailable' };
	if (auth.status !== 'authenticated')
		return { auth, usage: null, workspace: null, workspaceName: null };
	// On every app page, usage feeds the limit banner, the name feeds the sidebar tile, and the
	// role decides what the page offers.
	const [usage, workspace] = await Promise.all([
		loadUsage(platform, request.headers),
		loadWorkspace(platform, request.headers)
	]);
	return { auth, usage, workspace, workspaceName: workspace?.name ?? null };
};
