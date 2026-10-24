// SPDX-License-Identifier: AGPL-3.0-only
import { redirect } from '@sveltejs/kit';
import { fetchPages } from '@flared/server/web/api';
import { appRoutes } from '$lib/routes';
import type { PageList } from '@flared/contracts/pages';
import type { PageServerLoad } from './$types';

async function loadPages(
	platform: App.Platform | undefined,
	headers: Headers
): Promise<PageList | null> {
	const service = platform?.env.API_SERVICE;
	if (!service) return null;
	try {
		const result = await fetchPages(service, headers);
		return result.ok ? result.list : null;
	} catch {
		console.error(JSON.stringify({ event: 'pages_unavailable' }));
		return null;
	}
}

export const load: PageServerLoad = async ({ parent, platform, request }) => {
	const { auth } = await parent();
	if (auth.status === 'anonymous') redirect(303, appRoutes.login);
	if (auth.status !== 'authenticated') return { pages: null };
	return { pages: await loadPages(platform, request.headers) };
};
