// SPDX-License-Identifier: AGPL-3.0-only
import { readLimits } from '$lib/limits';
import type { PageServerLoad } from './$types';

// The section works without it; it then asks for a refresh.
export const load: PageServerLoad = async ({ parent, platform, request, url }) => {
	const { auth } = await parent();
	const env = platform?.env;
	if (auth.status !== 'authenticated' || !env) return { limits: null };
	try {
		return {
			limits: env.LIMITS_SERVICE
				? await readLimits(env.LIMITS_SERVICE, request.headers, url.origin)
				: null
		};
	} catch {
		console.error(JSON.stringify({ event: 'limits_unavailable' }));
		return { limits: null };
	}
};
