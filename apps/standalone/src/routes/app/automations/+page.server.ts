// SPDX-License-Identifier: AGPL-3.0-only
import { redirect } from '@sveltejs/kit';
import type { AutomationPage } from '@flared/contracts/automations';
import type { Workspace } from '@flared/contracts/workspace';
import type { AuthService } from '@flared/server/web';
import { fetchAutomations, fetchWebhooks } from '@flared/server/web/api';
import { appRoutes } from '$lib/routes';
import type { PageServerLoad } from './$types';

async function loadAutomations(
	service: AuthService,
	headers: Headers
): Promise<AutomationPage | null> {
	try {
		const result = await fetchAutomations(service, headers);
		return result.ok ? result.page : null;
	} catch {
		console.error(JSON.stringify({ event: 'automations_unavailable' }));
		return null;
	}
}

// Only the owner can read the webhook endpoints, which a template's webhook action names. Null
// for a member or on a failure: the list then neither offers nor checks endpoints.
async function loadEndpoints(
	service: AuthService,
	headers: Headers,
	workspace: Workspace | null
): Promise<{ id: string; url: string }[] | null> {
	if (workspace?.role !== 'owner') return null;
	try {
		const result = await fetchWebhooks(service, headers);
		return result.ok ? result.page.endpoints.map(({ id, url }) => ({ id, url })) : null;
	} catch {
		console.error(JSON.stringify({ event: 'webhooks_unavailable' }));
		return null;
	}
}

export const load: PageServerLoad = async ({ parent, platform, request }) => {
	const { auth, workspace } = await parent();
	if (auth.status === 'anonymous') redirect(303, appRoutes.login);
	const service = platform?.env.API_SERVICE;
	if (auth.status !== 'authenticated' || !service) return { automations: null, endpoints: null };
	const [automations, endpoints] = await Promise.all([
		loadAutomations(service, request.headers),
		loadEndpoints(service, request.headers, workspace)
	]);
	return { automations, endpoints };
};
