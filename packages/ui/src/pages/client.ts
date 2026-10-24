// SPDX-License-Identifier: AGPL-3.0-only
// Browser calls to the page routes of the /v1 API, and the link calls the page editor needs. The
// page passes its API base path, and the browser sends the session cookie and its Origin with
// each change.
import { isLink, isLinkPage, type Link } from '@flared/contracts/links';
import {
	isPage,
	type CreatePageBody,
	type Page,
	type PageImageSlot,
	type UpdatePageBody
} from '@flared/contracts/pages';

export interface PageFailure {
	code: string;
	// The API's own message, used when it names the exact problem with the input.
	message: string | null;
	field: string | null;
}

export type PageResult<T> = { ok: true; value: T } | { ok: false; failure: PageFailure };

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const unavailable: PageFailure = { code: 'SERVICE_UNAVAILABLE', message: null, field: null };

async function failureOf(response: Response): Promise<PageFailure> {
	const body: unknown = await response.json().catch(() => null);
	const error = record(body) && record(body.error) ? body.error : {};
	return {
		code: typeof error.code === 'string' ? error.code : 'SERVICE_UNAVAILABLE',
		message: typeof error.message === 'string' ? error.message : null,
		field: typeof error.field === 'string' ? error.field : null
	};
}

async function call<T>(
	request: () => Promise<Response>,
	expected: number,
	read: (body: unknown) => T | null
): Promise<PageResult<T>> {
	try {
		const response = await request();
		if (response.status !== expected) return { ok: false, failure: await failureOf(response) };
		const value = read(expected === 204 ? null : await response.json().catch(() => null));
		return value === null ? { ok: false, failure: unavailable } : { ok: true, value };
	} catch {
		return { ok: false, failure: unavailable };
	}
}

const pageOf = (body: unknown): Page | null =>
	record(body) && isPage(body.page) ? body.page : null;

const pagePath = (apiBase: string, id: string) => `${apiBase}/pages/${encodeURIComponent(id)}`;

export function createPage(
	apiBase: string,
	body: CreatePageBody,
	workspace: Record<string, string> = {}
): Promise<PageResult<Page>> {
	return call(
		() =>
			fetch(`${apiBase}/pages`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', ...workspace },
				body: JSON.stringify(body)
			}),
		201,
		pageOf
	);
}

export function updatePage(
	apiBase: string,
	id: string,
	change: UpdatePageBody,
	workspace: Record<string, string> = {}
): Promise<PageResult<Page>> {
	return call(
		() =>
			fetch(pagePath(apiBase, id), {
				method: 'PATCH',
				headers: { 'content-type': 'application/json', ...workspace },
				body: JSON.stringify(change)
			}),
		200,
		pageOf
	);
}

export function deletePage(
	apiBase: string,
	id: string,
	workspace: Record<string, string> = {}
): Promise<PageResult<true>> {
	return call(
		() => fetch(pagePath(apiBase, id), { method: 'DELETE', headers: workspace }),
		204,
		() => true
	);
}

export function setPageImage(
	apiBase: string,
	id: string,
	slot: PageImageSlot,
	file: File,
	workspace: Record<string, string> = {}
): Promise<PageResult<Page>> {
	return call(
		() =>
			fetch(`${pagePath(apiBase, id)}/${slot}-image`, {
				method: 'PUT',
				headers: { 'content-type': file.type, ...workspace },
				body: file
			}),
		200,
		pageOf
	);
}

export function removePageImage(
	apiBase: string,
	id: string,
	slot: PageImageSlot,
	workspace: Record<string, string> = {}
): Promise<PageResult<Page>> {
	return call(
		() => fetch(`${pagePath(apiBase, id)}/${slot}-image`, { method: 'DELETE', headers: workspace }),
		200,
		pageOf
	);
}

// A link for a button: the label becomes the link's title. The key makes a retry return the link
// that the first attempt created (a replay answers 201 too); a new destination needs a new key.
export function createButtonLink(
	apiBase: string,
	input: { destination: string; title: string; idempotencyKey: string },
	workspace: Record<string, string> = {}
): Promise<PageResult<Link>> {
	return call(
		() =>
			fetch(`${apiBase}/links`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'idempotency-key': input.idempotencyKey,
					...workspace
				},
				body: JSON.stringify({
					destination: input.destination.trim(),
					...(input.title.trim() ? { title: input.title.trim() } : {})
				})
			}),
		201,
		(body) => (record(body) && isLink(body.link) ? body.link : null)
	);
}

export function searchLinks(
	apiBase: string,
	search: string,
	workspace: Record<string, string> = {}
): Promise<PageResult<Link[]>> {
	const query = new URLSearchParams({ limit: '20' });
	if (search.trim()) query.set('q', search.trim());
	return call(
		() => fetch(`${apiBase}/links?${query}`, { headers: workspace }),
		200,
		(body) => (isLinkPage(body) ? body.links : null)
	);
}

export function pageErrorMessage(failure: PageFailure): string {
	switch (failure.code) {
		// The API names the exact problem with the input, with the same rules as the editor.
		case 'INVALID_INPUT':
		case 'HANDLE_TAKEN':
		case 'PAGE_LIMIT_REACHED':
		case 'PAGE_EXTRAS_REQUIRES_PLAN':
		case 'PAGE_DOMAIN_TAKEN':
		case 'DOMAIN_UNAVAILABLE':
		case 'PLAN_LIMIT_REACHED':
		case 'DEFAULT_DOMAIN_UNAVAILABLE':
			return failure.message ?? 'Check the page and try again.';
		case 'PAGE_BLOCKED':
			return 'Flared blocked this page for abuse. You cannot change it.';
		case 'UNSUPPORTED_MEDIA_TYPE':
			return 'Upload a PNG, JPEG, or WebP image.';
		case 'PAYLOAD_TOO_LARGE':
			return 'Use an image of at most 5 MB.';
		case 'RATE_LIMITED':
			return 'You are making changes too quickly. Wait a minute and try again.';
		case 'NOT_FOUND':
			return 'This page was deleted. Reload the page list.';
		case 'UNAUTHENTICATED':
			return 'Your session ended. Sign in again.';
		// The API says what to retry, such as an image that changed during the upload.
		case 'SERVICE_UNAVAILABLE':
			return failure.message ?? 'Something went wrong. Try again.';
		case 'WORKSPACE_CHANGED':
			return 'You switched workspaces in another tab. Reload the page to continue.';
		default:
			return 'Something went wrong. Try again.';
	}
}
