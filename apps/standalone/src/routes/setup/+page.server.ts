// SPDX-License-Identifier: AGPL-3.0-only
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent, url }) => {
	const { installation } = await parent();
	return { state: installation.state, host: url.host };
};
