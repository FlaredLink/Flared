// SPDX-License-Identifier: AGPL-3.0-only
import { redirect } from '@sveltejs/kit';
import { settingsRoutes } from '$lib/routes';
import type { PageServerLoad } from './$types';

// Settings was one page. A browser keeps the address's #section across the redirect, and the
// Settings layout opens the section of that anchor.
export const load: PageServerLoad = () => {
	redirect(303, settingsRoutes.account);
};
