// SPDX-License-Identifier: AGPL-3.0-only
import { redirect } from '@sveltejs/kit';
import { appRoutes } from '$lib/routes';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent }) => {
	const { installation } = await parent();
	if (installation.state === 'closed') return {};
	redirect(303, installation.state === 'active' ? appRoutes.app : appRoutes.setup);
};
