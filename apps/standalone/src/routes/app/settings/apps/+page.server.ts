// SPDX-License-Identifier: AGPL-3.0-only
import { fetchConnectedApps } from '@flared/server/web/api';
import type { PageServerLoad } from './$types';

// The section works without it; it then asks for a refresh.
export const load: PageServerLoad = async ({ parent, platform, request, url }) => {
	const { auth } = await parent();
	const env = platform?.env;
	if (auth.status !== 'authenticated' || !env) return { apps: null };
	try {
		if (!env.API_SERVICE) return { apps: null };
		const result = await fetchConnectedApps(env.API_SERVICE, request.headers);
		return { apps: result.ok ? result.page : null };
	} catch {
		console.error(JSON.stringify({ event: 'connected_apps_unavailable' }));
		return { apps: null };
	}
};
