// SPDX-License-Identifier: AGPL-3.0-only
import { fetchMembers } from '@flared/server/web/api';
import type { PageServerLoad } from './$types';

// The section works without it; it then asks for a refresh.
export const load: PageServerLoad = async ({ parent, platform, request, url }) => {
	const { auth } = await parent();
	const env = platform?.env;
	if (auth.status !== 'authenticated' || !env) return { members: null };
	try {
		if (!env.API_SERVICE) return { members: null };
		const result = await fetchMembers(env.API_SERVICE, request.headers);
		return { members: result.ok ? result.page : null };
	} catch {
		console.error(JSON.stringify({ event: 'members_unavailable' }));
		return { members: null };
	}
};
