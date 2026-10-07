// SPDX-License-Identifier: AGPL-3.0-only
import { redirect } from '@sveltejs/kit';
import { nextFromSearch, pendingAuthorization } from '@flared/ui/navigation';
import { appRoutes } from '$lib/routes';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent, url }) => {
	const { auth, installation } = await parent();
	// An app's authorization request continues after sign-in.
	const resume = pendingAuthorization(url.search);
	if (auth.status === 'authenticated' && !installation.moving)
		redirect(303, resume ?? nextFromSearch(url.search) ?? appRoutes.app);
	return {
		unavailable: auth.status === 'unavailable',
		connecting: resume !== null,
		moving: installation.moving
	};
};
