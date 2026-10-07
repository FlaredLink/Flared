// SPDX-License-Identifier: AGPL-3.0-only
import { fail, redirect } from '@sveltejs/kit';
import type { Domain } from '@flared/contracts/domains';
import type { ListedLink } from '@flared/contracts/links';
import { createLink, fetchDomains, fetchLinks, type ApiFailure } from '@flared/server/web/api';
import { appRoutes } from '$lib/routes';
import type { Actions, PageServerLoad } from './$types';

type LinksState =
	{ status: 'ready'; links: ListedLink[]; nextCursor: string | null } | { status: 'unavailable' };

// The domain picker is optional: without it, new links use the default domain.
async function loadActiveDomains(
	platform: App.Platform | undefined,
	headers: Headers
): Promise<Pick<Domain, 'id' | 'hostname' | 'isDefault'>[]> {
	const service = platform?.env.API_SERVICE;
	if (!service) return [];
	try {
		const result = await fetchDomains(service, headers);
		return result.ok
			? result.page.domains
					.filter((domain) => domain.state === 'active')
					.map(({ id, hostname, isDefault }) => ({ id, hostname, isDefault }))
			: [];
	} catch {
		console.error(JSON.stringify({ event: 'domains_unavailable' }));
		return [];
	}
}

async function loadLinks(
	platform: App.Platform | undefined,
	headers: Headers,
	cursor: string | null
): Promise<LinksState> {
	const service = platform?.env.API_SERVICE;
	if (!service) return { status: 'unavailable' };
	try {
		const result = await fetchLinks(service, headers, cursor);
		return result.ok ? { status: 'ready', ...result.page } : { status: 'unavailable' };
	} catch {
		console.error(JSON.stringify({ event: 'links_unavailable' }));
		return { status: 'unavailable' };
	}
}

function text(form: FormData, name: string): string {
	const value = form.get(name);
	return typeof value === 'string' ? value : '';
}

export const load: PageServerLoad = async ({ parent, platform, request, url }) => {
	const { auth } = await parent();
	if (auth.status === 'anonymous') redirect(303, appRoutes.login);
	const ready = auth.status === 'authenticated';
	const [links, domains] = ready
		? await Promise.all([
				loadLinks(platform, request.headers, url.searchParams.get('cursor')),
				loadActiveDomains(platform, request.headers)
			])
		: [{ status: 'unavailable' } as const, []];
	// A fresh key per page view: a double submit reuses it, a new link after success does not.
	return { links, domains, idempotencyKey: crypto.randomUUID() };
};

export const actions: Actions = {
	create: async ({ request, platform }) => {
		const form = await request.formData().catch(() => null);
		const values = {
			destination: form ? text(form, 'destination') : '',
			slug: form ? text(form, 'slug') : '',
			title: form ? text(form, 'title') : '',
			// Empty means the default domain; the API checks that an ID is active and ours.
			domainId: form ? text(form, 'domainId') : ''
		};
		const key = form ? text(form, 'idempotencyKey') : '';
		const service = platform?.env.API_SERVICE;
		const failure = (problem: Pick<ApiFailure, 'code' | 'message' | 'status' | 'field'>) =>
			// A stored or validation rejection needs a new key for the corrected input; a server
			// error stored nothing, so the same key stays safe to retry.
			fail(problem.status, {
				error: { code: problem.code, message: problem.message, field: problem.field },
				values,
				idempotencyKey: problem.status >= 500 ? key : crypto.randomUUID()
			});
		const unavailable = {
			code: 'SERVICE_UNAVAILABLE',
			message: 'Link creation is not available. Try again.',
			status: 503,
			field: null
		};
		if (!service || !key) return failure(unavailable);
		try {
			const result = await createLink(service, request.headers, key, values);
			if (!result.ok) return failure(result.failure);
			return { created: result.link };
		} catch {
			console.error(JSON.stringify({ event: 'link_create_failed' }));
			return failure(unavailable);
		}
	}
};
