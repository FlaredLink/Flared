// SPDX-License-Identifier: AGPL-3.0-only
import { fetchWebhooks } from '@flared/server/web/api';
import type { PageServerLoad } from './$types';

// Only the owner manages webhooks, and the API refuses the list to anyone else. The section
// works without the list; it then asks for a refresh.
export const load: PageServerLoad = async ({ parent, platform, request }) => {
	const { auth, workspace } = await parent();
	const service = platform?.env?.API_SERVICE;
	if (auth.status !== 'authenticated' || workspace?.role !== 'owner' || !service)
		return { webhooks: null };
	try {
		const result = await fetchWebhooks(service, request.headers);
		return { webhooks: result.ok ? result.page : null };
	} catch {
		console.error(JSON.stringify({ event: 'webhooks_unavailable' }));
		return { webhooks: null };
	}
};
