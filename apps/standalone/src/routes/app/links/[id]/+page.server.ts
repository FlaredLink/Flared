// SPDX-License-Identifier: AGPL-3.0-only
import { error, fail, redirect } from '@sveltejs/kit';
import { oldestRetainedDay, utcDay, type LinkAnalytics } from '@flared/contracts/analytics';
import type { AutomationPage } from '@flared/contracts/automations';
import type { Link } from '@flared/contracts/links';
import {
	fetchAutomations,
	fetchLink,
	fetchLinkAnalytics,
	linkChangeOf,
	updateLink,
	type ApiFailure
} from '@flared/server/web/api';
import type { AuthService } from '@flared/server/web';
import { appRoutes } from '$lib/routes';
import type { Actions, PageServerLoad } from './$types';

type AnalyticsState = { status: 'ready'; analytics: LinkAnalytics } | { status: 'unavailable' };

// The templates to apply. Without them, the page still lists the link's automations.
async function loadAutomations(
	service: AuthService,
	headers: Headers
): Promise<AutomationPage | null> {
	try {
		const result = await fetchAutomations(service, headers);
		return result.ok ? result.page : null;
	} catch {
		console.error(JSON.stringify({ event: 'automations_unavailable' }));
		return null;
	}
}

export const load: PageServerLoad = async ({ parent, platform, request, params, url }) => {
	const { auth } = await parent();
	if (auth.status === 'anonymous') redirect(303, appRoutes.login);
	const service = platform?.env.API_SERVICE;
	if (auth.status !== 'authenticated' || !service) error(503, 'Analytics are not available.');
	const days = url.searchParams.get('days') === '7' ? 7 : 30;
	// The QR code view needs only the link.
	const view: 'analytics' | 'qr' = url.searchParams.get('view') === 'qr' ? 'qr' : 'analytics';
	const now = Date.now();
	const range = { from: oldestRetainedDay(now, days), to: utcDay(now) };
	let link: Link;
	let analytics: AnalyticsState | null;
	let automations: AutomationPage | null;
	try {
		const [linkResult, analyticsResult, automationPage] = await Promise.all([
			fetchLink(service, request.headers, params.id),
			view === 'analytics' ? fetchLinkAnalytics(service, request.headers, params.id, range) : null,
			view === 'analytics' ? loadAutomations(service, request.headers) : null
		]);
		if (!linkResult.ok) {
			if (linkResult.failure.status === 404) error(404, 'Link not found.');
			error(503, 'This link is not available. Try again.');
		}
		link = linkResult.link;
		analytics = !analyticsResult
			? null
			: analyticsResult.ok
				? { status: 'ready', analytics: analyticsResult.analytics }
				: { status: 'unavailable' };
		automations = automationPage;
	} catch (cause) {
		if (cause && typeof cause === 'object' && 'status' in cause) throw cause;
		console.error(JSON.stringify({ event: 'link_analytics_unavailable' }));
		error(503, 'This link is not available. Try again.');
	}
	return { link, analytics, automations, days, view };
};

export const actions: Actions = {
	update: async ({ request, platform, params }) => {
		const form = await request.formData().catch(() => null);
		const change = form ? linkChangeOf(form) : null;
		// The page gets the fields back after a failure, never the password.
		const values = change && 'destination' in change ? { ...change, password: undefined } : null;
		const failure = (problem: Pick<ApiFailure, 'code' | 'message' | 'status' | 'field'>) =>
			fail(problem.status, {
				error: { code: problem.code, message: problem.message, field: problem.field },
				values
			});
		const service = platform?.env.API_SERVICE;
		if (!change)
			return failure({
				code: 'VALIDATION_ERROR',
				message: 'Choose a change to make.',
				status: 400,
				field: null
			});
		if (!service)
			return failure({
				code: 'SERVICE_UNAVAILABLE',
				message: 'Changing links is not available. Try again.',
				status: 503,
				field: null
			});
		try {
			const result = await updateLink(service, request.headers, params.id, change);
			if (!result.ok) return failure(result.failure);
			const updated: 'edit' | 'enable' | 'disable' =
				'enabled' in change ? (change.enabled ? 'enable' : 'disable') : 'edit';
			return { updated };
		} catch {
			console.error(JSON.stringify({ event: 'link_update_failed' }));
			return failure({
				code: 'SERVICE_UNAVAILABLE',
				message: 'Changing links is not available. Try again.',
				status: 503,
				field: null
			});
		}
	}
};
