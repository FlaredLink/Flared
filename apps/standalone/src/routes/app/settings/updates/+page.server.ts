// SPDX-License-Identifier: AGPL-3.0-only
import { redirect } from '@sveltejs/kit';
import { settingsRoutes } from '$lib/routes';
import type { PageServerLoad } from './$types';

// Only the owner sees and changes update checks; the app layout loads them for the owner only.
export const load: PageServerLoad = async ({ parent }) => {
	const { workspace } = await parent();
	if (workspace !== null && workspace.role !== 'owner') redirect(303, settingsRoutes.workspace);
};
