// SPDX-License-Identifier: AGPL-3.0-only
import { redirect } from '@sveltejs/kit';
import { getPasskeys } from '@flared/server/web/auth';
import { appRoutes } from '$lib/routes';
import type { LayoutServerLoad } from './$types';

// Every section can ask the person to confirm a recent sign-in. The passkey list says whether
// a passkey can confirm it, and until when the last sign-in counts as recent.
export const load: LayoutServerLoad = async ({ parent, platform, request, url }) => {
	const { auth } = await parent();
	if (auth.status === 'anonymous') redirect(303, appRoutes.login);
	const service = platform?.env?.AUTH_SERVICE;
	if (auth.status !== 'authenticated' || !service) return { passkeys: null };
	try {
		return { passkeys: await getPasskeys(service, request.headers, url.origin) };
	} catch {
		console.error(JSON.stringify({ event: 'passkeys_unavailable' }));
		return { passkeys: null };
	}
};
