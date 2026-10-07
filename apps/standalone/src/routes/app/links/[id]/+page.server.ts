// SPDX-License-Identifier: AGPL-3.0-only
import { error, redirect } from '@sveltejs/kit';
import { oldestRetainedDay, utcDay, type LinkAnalytics } from '@flared/contracts/analytics';
import type { Link } from '@flared/contracts/links';
import { fetchLink, fetchLinkAnalytics } from '@flared/server/web/api';
import { appRoutes } from '$lib/routes';
import type { PageServerLoad } from './$types';

type AnalyticsState = { status: 'ready'; analytics: LinkAnalytics } | { status: 'unavailable' };

export const load: PageServerLoad = async ({ parent, platform, request, params, url }) => {
	const { auth } = await parent();
	if (auth.status === 'anonymous') redirect(303, appRoutes.login);
	const service = platform?.env.API_SERVICE;
	if (auth.status !== 'authenticated' || !service) error(503, 'Analytics are not available.');
	const days = url.searchParams.get('days') === '7' ? 7 : 30;
	const now = Date.now();
	const range = { from: oldestRetainedDay(now, days), to: utcDay(now) };
	let link: Link;
	let analytics: AnalyticsState;
	try {
		const [linkResult, analyticsResult] = await Promise.all([
			fetchLink(service, request.headers, params.id),
			fetchLinkAnalytics(service, request.headers, params.id, range)
		]);
		if (!linkResult.ok) {
			if (linkResult.failure.status === 404) error(404, 'Link not found.');
			error(503, 'This link is not available. Try again.');
		}
		link = linkResult.link;
		analytics = analyticsResult.ok
			? { status: 'ready', analytics: analyticsResult.analytics }
			: { status: 'unavailable' };
	} catch (cause) {
		if (cause && typeof cause === 'object' && 'status' in cause) throw cause;
		console.error(JSON.stringify({ event: 'link_analytics_unavailable' }));
		error(503, 'This link is not available. Try again.');
	}
	return { link, analytics, days };
};
