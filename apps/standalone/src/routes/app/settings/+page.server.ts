// SPDX-License-Identifier: AGPL-3.0-only
import { redirect } from '@sveltejs/kit';
import type { ConnectedAppPage } from '@flared/contracts/oauth';
import type { ApiTokenPage } from '@flared/contracts/tokens';
import { fetchConnectedApps, fetchTokens } from '@flared/server/web/api';
import { getPasskeys } from '@flared/server/web/auth';
import { appRoutes } from '$lib/routes';
import { readLimits, type LimitsView } from '$lib/limits';
import type { PageServerLoad } from './$types';

// Each section is optional: the page works when one of them cannot load.
async function optional<T>(event: string, load: () => Promise<T | null>): Promise<T | null> {
	try {
		return await load();
	} catch {
		console.error(JSON.stringify({ event }));
		return null;
	}
}

export const load: PageServerLoad = async ({ parent, platform, request, url }) => {
	const { auth } = await parent();
	if (auth.status === 'anonymous') redirect(303, appRoutes.login);
	const env = platform?.env;
	if (auth.status !== 'authenticated' || !env)
		return { passkeys: null, tokens: null, apps: null, limits: null };
	const headers = request.headers;
	const [passkeys, tokens, apps, limits] = await Promise.all([
		optional('passkeys_unavailable', async () =>
			env.AUTH_SERVICE ? getPasskeys(env.AUTH_SERVICE, headers, url.origin) : null
		),
		optional<ApiTokenPage>('tokens_unavailable', async () => {
			if (!env.API_SERVICE) return null;
			const result = await fetchTokens(env.API_SERVICE, headers);
			return result.ok ? result.page : null;
		}),
		optional<ConnectedAppPage>('connected_apps_unavailable', async () => {
			if (!env.API_SERVICE) return null;
			const result = await fetchConnectedApps(env.API_SERVICE, headers);
			return result.ok ? result.page : null;
		}),
		optional<LimitsView>('limits_unavailable', async () =>
			env.LIMITS_SERVICE ? readLimits(env.LIMITS_SERVICE, headers, url.origin) : null
		)
	]);
	return { passkeys, tokens, apps, limits };
};
