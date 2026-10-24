// SPDX-License-Identifier: AGPL-3.0-only
import { error, redirect } from '@sveltejs/kit';
import { oldestRetainedDay, utcDay, type PageAnalytics } from '@flared/contracts/analytics';
import type { Page } from '@flared/contracts/pages';
import { fetchDomains, fetchPage, fetchPageAnalytics } from '@flared/server/web/api';
import { appRoutes } from '$lib/routes';
import type { PageServerLoad } from './$types';

type AnalyticsState = { status: 'ready'; analytics: PageAnalytics } | { status: 'unavailable' };

export const load: PageServerLoad = async ({ parent, platform, request, params, url }) => {
	const { auth } = await parent();
	if (auth.status === 'anonymous') redirect(303, appRoutes.login);
	const service = platform?.env.API_SERVICE;
	if (auth.status !== 'authenticated' || !service) error(503, 'Pages are not available.');
	const shown = url.searchParams.get('view');
	const view: 'edit' | 'analytics' | 'qr' =
		shown === 'analytics' || shown === 'qr' ? shown : 'edit';
	const days = url.searchParams.get('days') === '7' ? 7 : 30;
	const now = Date.now();
	const range = { from: oldestRetainedDay(now, days), to: utcDay(now) };
	let page: Page;
	let analytics: AnalyticsState | null = null;
	let domains: { id: string; hostname: string }[] = [];
	try {
		const [pageResult, analyticsResult, domainResult] = await Promise.all([
			fetchPage(service, request.headers, params.id),
			view === 'analytics' ? fetchPageAnalytics(service, request.headers, params.id, range) : null,
			view === 'edit' ? fetchDomains(service, request.headers) : null
		]);
		if (!pageResult.ok) {
			if (pageResult.failure.status === 404) error(404, 'Page not found.');
			error(503, 'This page is not available. Try again.');
		}
		page = pageResult.page;
		if (analyticsResult)
			analytics = analyticsResult.ok
				? { status: 'ready', analytics: analyticsResult.analytics }
				: { status: 'unavailable' };
		// Active workspace domains can show a page, and the page's own domain stays a choice.
		if (domainResult?.ok)
			domains = domainResult.page.domains
				.filter(
					(domain) =>
						domain.kind === 'workspace' &&
						(domain.state === 'active' || domain.id === page.domainId)
				)
				.map((domain) => ({ id: domain.id, hostname: domain.hostname }));
	} catch (cause) {
		if (cause && typeof cause === 'object' && 'status' in cause) throw cause;
		console.error(JSON.stringify({ event: 'page_unavailable' }));
		error(503, 'This page is not available. Try again.');
	}
	return { page, analytics, domains, view, days, template: url.searchParams.get('template') };
};
