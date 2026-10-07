// SPDX-License-Identifier: AGPL-3.0-only
import { isRedirect, redirect } from '@sveltejs/kit';
import { isConsentRequest, type ConsentRequest } from '@flared/contracts/oauth';
import { appRoutes } from '$lib/routes';
import type { PageServerLoad } from './$types';

export type ConsentState =
	| { status: 'ready'; request: ConsentRequest; oauthQuery: string; account: string }
	| { status: 'expired' }
	| { status: 'invalid' }
	| { status: 'workspace' }
	| { status: 'unavailable' };

// Errors the authorization server sends here before it can trust the app's redirect URI. The
// page shows its own text for each; it never shows text from the URL.
const invalidRequestErrors = new Set([
	'invalid_client',
	'invalid_redirect',
	'client_disabled',
	'unauthorized_client',
	'unsupported_response_type',
	'invalid_request'
]);

export const load: PageServerLoad = async ({ parent, url, platform, request }) => {
	const { auth } = await parent();
	const error = url.searchParams.get('error');
	if (error)
		return {
			state: (invalidRequestErrors.has(error)
				? { status: 'invalid' }
				: { status: 'unavailable' }) satisfies ConsentState
		};
	const oauthQuery = url.search.slice(1);
	// The sign-in page continues the same request afterwards.
	if (auth.status === 'anonymous') redirect(303, `${appRoutes.login}?${oauthQuery}`);
	const service = platform?.env.OAUTH_SERVICE;
	if (auth.status !== 'authenticated' || !service)
		return { state: { status: 'unavailable' } satisfies ConsentState };

	const headers = new Headers();
	const cookie = request.headers.get('cookie');
	if (cookie !== null) headers.set('cookie', cookie);
	let state: ConsentState = { status: 'unavailable' };
	try {
		const response = await service.fetch(
			new Request(new URL(`/oauth2/consent/request?${oauthQuery}`, url.origin), { headers })
		);
		if (response.status === 401) redirect(303, `${appRoutes.login}?${oauthQuery}`);
		const body: unknown = await response.json().catch(() => null);
		if (response.status === 200 && isConsentRequest(body))
			state = {
				status: 'ready',
				request: body,
				oauthQuery,
				account: auth.principal.user.name
			};
		else if (response.status === 400) state = { status: 'expired' };
		else if (response.status === 409) state = { status: 'workspace' };
	} catch (error) {
		if (isRedirect(error)) throw error;
		console.error(JSON.stringify({ event: 'consent_request_unavailable' }));
	}
	return { state };
};
