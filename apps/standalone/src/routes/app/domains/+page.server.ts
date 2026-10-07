// SPDX-License-Identifier: AGPL-3.0-only
import { redirect } from '@sveltejs/kit';
import { fetchDomains } from '@flared/server/web/api';
import { appRoutes } from '$lib/routes';
import type { DomainPage } from '@flared/contracts/domains';
import type { PageServerLoad } from './$types';

async function loadDomains(
	platform: App.Platform | undefined,
	headers: Headers
): Promise<DomainPage | null> {
	const service = platform?.env.API_SERVICE;
	if (!service) return null;
	try {
		const result = await fetchDomains(service, headers);
		return result.ok ? result.page : null;
	} catch {
		console.error(JSON.stringify({ event: 'domains_unavailable' }));
		return null;
	}
}

export const load: PageServerLoad = async ({ parent, platform, request }) => {
	const { auth } = await parent();
	if (auth.status === 'anonymous') redirect(303, appRoutes.login);
	if (auth.status !== 'authenticated') return { domains: null };
	return { domains: await loadDomains(platform, request.headers) };
};
