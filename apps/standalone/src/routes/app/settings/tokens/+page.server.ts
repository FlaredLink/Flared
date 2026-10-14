// SPDX-License-Identifier: AGPL-3.0-only
import { fetchTokens } from '@flared/server/web/api';
import type { PageServerLoad } from './$types';

// The section works without it; it then asks for a refresh.
export const load: PageServerLoad = async ({ parent, platform, request, url }) => {
	const { auth } = await parent();
	const env = platform?.env;
	if (auth.status !== 'authenticated' || !env) return { tokens: null };
	try {
		if (!env.API_SERVICE) return { tokens: null };
		const result = await fetchTokens(env.API_SERVICE, request.headers);
		return { tokens: result.ok ? result.page : null };
	} catch {
		console.error(JSON.stringify({ event: 'tokens_unavailable' }));
		return { tokens: null };
	}
};
