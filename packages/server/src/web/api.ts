// SPDX-License-Identifier: AGPL-3.0-only
import { isErrorCode } from '@flared/contracts/errors';
import {
	isUsage,
	type DimensionClicks,
	type LinkAnalytics,
	type Usage
} from '@flared/contracts/analytics';
import {
	recentClickDays,
	type Link,
	type LinkPage,
	type ListedLink
} from '@flared/contracts/links';
import { isApiTokenPage, type ApiTokenPage } from '@flared/contracts/tokens';
import { isConnectedAppPage, type ConnectedAppPage } from '@flared/contracts/oauth';
import { isDomainPage, type DomainPage } from '@flared/contracts/domains';
import { isWorkspace, type Workspace } from '@flared/contracts/workspace';
import type { AuthService } from './forward';

// The application side of the product API: typed reads and writes for server-rendered pages.
// The API runs in the same Worker. Requests carry only the session cookie and, for writes, the
// browser's own Origin, which the API checks again.
export type ApiService = AuthService;

export type ApiFailure = { code: string; message: string; status: number; field: string | null };

function apiRequest(path: string, init: { method: string; headers: Headers; body?: string }) {
	return new Request(new URL(path, 'https://api.internal'), init);
}

function forwardedHeaders(source: Headers, extra: Record<string, string> = {}): Headers {
	const headers = new Headers(extra);
	for (const name of ['cookie', 'origin']) {
		const value = source.get(name);
		if (value !== null) headers.set(name, value);
	}
	return headers;
}

async function failureOf(response: Response): Promise<ApiFailure> {
	const body: unknown = await response.json().catch(() => null);
	const error =
		typeof body === 'object' && body !== null
			? Object.entries(body).find(([key]) => key === 'error')?.[1]
			: undefined;
	const fields =
		typeof error === 'object' && error !== null ? Object.fromEntries(Object.entries(error)) : {};
	return {
		code: isErrorCode(fields.code) ? fields.code : 'SERVICE_UNAVAILABLE',
		message:
			typeof fields.message === 'string' ? fields.message : 'Something went wrong. Try again.',
		status: response.status,
		field: typeof fields.field === 'string' ? fields.field : null
	};
}

function isLink(value: unknown): value is Link {
	if (typeof value !== 'object' || value === null) return false;
	const link = Object.fromEntries(Object.entries(value));
	return (
		typeof link.id === 'string' &&
		typeof link.shortUrl === 'string' &&
		typeof link.destination === 'string' &&
		typeof link.enabled === 'boolean' &&
		typeof link.createdAt === 'string'
	);
}

export async function fetchLinks(
	service: ApiService,
	headers: Headers,
	cursor: string | null,
	filters: { search?: string | null; domainId?: string | null } = {}
): Promise<{ ok: true; page: LinkPage } | { ok: false; failure: ApiFailure }> {
	const params = new URLSearchParams();
	if (cursor) params.set('cursor', cursor);
	if (filters.search) params.set('q', filters.search);
	if (filters.domainId) params.set('domain', filters.domainId);
	const query = params.size ? `?${params}` : '';
	const response = await service.fetch(
		apiRequest(`/v1/links${query}`, { method: 'GET', headers: forwardedHeaders(headers) })
	);
	if (!response.ok) return { ok: false, failure: await failureOf(response) };
	const body: unknown = await response.json();
	const page =
		typeof body === 'object' && body !== null ? Object.fromEntries(Object.entries(body)) : {};
	const links: ListedLink[] = Array.isArray(page.links)
		? page.links.filter(isLink).map((link) => {
				const clicks: unknown = Reflect.get(link, 'clicksLast30Days');
				const daily: unknown = Reflect.get(link, 'dailyClicksLast30Days');
				return {
					...link,
					clicksLast30Days: count(clicks) ? clicks : null,
					dailyClicksLast30Days:
						Array.isArray(daily) && daily.length === recentClickDays && daily.every(count)
							? daily
							: null
				};
			})
		: [];
	return {
		ok: true,
		page: { links, nextCursor: typeof page.nextCursor === 'string' ? page.nextCursor : null }
	};
}

export async function createLink(
	service: ApiService,
	headers: Headers,
	idempotencyKey: string,
	input: { destination: string; slug: string; title: string; domainId: string }
): Promise<{ ok: true; link: Link } | { ok: false; failure: ApiFailure }> {
	const response = await service.fetch(
		apiRequest('/v1/links', {
			method: 'POST',
			headers: forwardedHeaders(headers, {
				'content-type': 'application/json',
				'idempotency-key': idempotencyKey
			}),
			body: JSON.stringify({
				destination: input.destination,
				slug: input.slug || null,
				title: input.title || null,
				// Empty means the installation default.
				...(input.domainId ? { domainId: input.domainId } : {})
			})
		})
	);
	if (response.status !== 201) return { ok: false, failure: await failureOf(response) };
	const body: unknown = await response.json();
	const link =
		typeof body === 'object' && body !== null
			? Object.entries(body).find(([key]) => key === 'link')?.[1]
			: undefined;
	return isLink(link)
		? { ok: true, link }
		: {
				ok: false,
				failure: { code: 'SERVICE_UNAVAILABLE', message: 'Try again.', status: 503, field: null }
			};
}

function fields(value: unknown): Record<string, unknown> {
	return typeof value === 'object' && value !== null
		? Object.fromEntries(Object.entries(value))
		: {};
}

function count(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function day(value: unknown): value is string {
	return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function dimensionRows(value: unknown): DimensionClicks[] | null {
	if (!Array.isArray(value)) return null;
	const rows = value.map(fields);
	return rows.every((row) => typeof row.value === 'string' && count(row.clicks))
		? rows.map((row) => ({ value: String(row.value), clicks: Number(row.clicks) }))
		: null;
}

function toAnalytics(value: unknown): LinkAnalytics | null {
	const body = fields(value);
	const days = Array.isArray(body.days) ? body.days.map(fields) : null;
	const countries = dimensionRows(body.countries);
	const devices = dimensionRows(body.devices);
	const referrers = dimensionRows(body.referrers);
	const browsers = dimensionRows(body.browsers);
	const operatingSystems = dimensionRows(body.operatingSystems);
	if (
		typeof body.linkId !== 'string' ||
		!day(body.from) ||
		!day(body.to) ||
		!count(body.total) ||
		typeof body.asOf !== 'string' ||
		!days ||
		!days.every((row) => day(row.day) && count(row.clicks)) ||
		!countries ||
		!devices ||
		!referrers ||
		!browsers ||
		!operatingSystems
	)
		return null;
	return {
		linkId: body.linkId,
		from: body.from,
		to: body.to,
		total: body.total,
		days: days.map((row) => ({ day: String(row.day), clicks: Number(row.clicks) })),
		countries,
		devices,
		referrers,
		browsers,
		operatingSystems,
		asOf: body.asOf
	};
}

async function getJson(service: ApiService, headers: Headers, path: string) {
	const response = await service.fetch(
		apiRequest(path, { method: 'GET', headers: forwardedHeaders(headers) })
	);
	if (!response.ok) return { ok: false as const, failure: await failureOf(response) };
	return { ok: true as const, body: fields(await response.json()) };
}

const malformed: ApiFailure = {
	code: 'SERVICE_UNAVAILABLE',
	message: 'Try again.',
	status: 503,
	field: null
};

export async function fetchLink(
	service: ApiService,
	headers: Headers,
	id: string
): Promise<{ ok: true; link: Link } | { ok: false; failure: ApiFailure }> {
	const result = await getJson(service, headers, `/v1/links/${encodeURIComponent(id)}`);
	if (!result.ok) return result;
	return isLink(result.body.link)
		? { ok: true, link: result.body.link }
		: { ok: false, failure: malformed };
}

// The fields of PATCH /v1/links/:id. An empty title clears it.
export type LinkChange = { destination: string; title: string } | { enabled: boolean };

// The change that LinkEditForm submits: intent "edit" with the fields, or "enable" or "disable".
export function linkChangeOf(form: FormData): LinkChange | null {
	const text = (name: string) => {
		const value = form.get(name);
		return typeof value === 'string' ? value : '';
	};
	switch (text('intent')) {
		case 'edit':
			return { destination: text('destination'), title: text('title') };
		case 'enable':
			return { enabled: true };
		case 'disable':
			return { enabled: false };
		default:
			return null;
	}
}

export async function updateLink(
	service: ApiService,
	headers: Headers,
	id: string,
	change: LinkChange
): Promise<{ ok: true; link: Link } | { ok: false; failure: ApiFailure }> {
	const body =
		'enabled' in change
			? { enabled: change.enabled }
			: { destination: change.destination, title: change.title || null };
	const response = await service.fetch(
		apiRequest(`/v1/links/${encodeURIComponent(id)}`, {
			method: 'PATCH',
			headers: forwardedHeaders(headers, { 'content-type': 'application/json' }),
			body: JSON.stringify(body)
		})
	);
	if (!response.ok) return { ok: false, failure: await failureOf(response) };
	const link = fields(await response.json().catch(() => null)).link;
	return isLink(link) ? { ok: true, link } : { ok: false, failure: malformed };
}

export async function fetchLinkAnalytics(
	service: ApiService,
	headers: Headers,
	id: string,
	range: { from: string; to: string }
): Promise<{ ok: true; analytics: LinkAnalytics } | { ok: false; failure: ApiFailure }> {
	const query = new URLSearchParams(range);
	const result = await getJson(
		service,
		headers,
		`/v1/links/${encodeURIComponent(id)}/analytics?${query}`
	);
	if (!result.ok) return result;
	const analytics = toAnalytics(result.body.analytics);
	return analytics ? { ok: true, analytics } : { ok: false, failure: malformed };
}

export async function fetchUsage(
	service: ApiService,
	headers: Headers
): Promise<{ ok: true; usage: Usage } | { ok: false; failure: ApiFailure }> {
	const result = await getJson(service, headers, '/v1/usage');
	if (!result.ok) return result;
	const usage = result.body.usage;
	return isUsage(usage) ? { ok: true, usage } : { ok: false, failure: malformed };
}

export async function fetchWorkspace(
	service: ApiService,
	headers: Headers
): Promise<{ ok: true; workspace: Workspace } | { ok: false; failure: ApiFailure }> {
	const result = await getJson(service, headers, '/v1/workspace');
	if (!result.ok) return result;
	const workspace = result.body.workspace;
	return isWorkspace(workspace) ? { ok: true, workspace } : { ok: false, failure: malformed };
}

export async function fetchTokens(
	service: ApiService,
	headers: Headers
): Promise<{ ok: true; page: ApiTokenPage } | { ok: false; failure: ApiFailure }> {
	const result = await getJson(service, headers, '/v1/tokens');
	if (!result.ok) return result;
	return isApiTokenPage(result.body)
		? { ok: true, page: result.body }
		: { ok: false, failure: malformed };
}

export async function fetchConnectedApps(
	service: ApiService,
	headers: Headers
): Promise<{ ok: true; page: ConnectedAppPage } | { ok: false; failure: ApiFailure }> {
	const result = await getJson(service, headers, '/v1/connected-apps');
	if (!result.ok) return result;
	return isConnectedAppPage(result.body)
		? { ok: true, page: result.body }
		: { ok: false, failure: malformed };
}

export async function fetchDomains(
	service: ApiService,
	headers: Headers
): Promise<{ ok: true; page: DomainPage } | { ok: false; failure: ApiFailure }> {
	const result = await getJson(service, headers, '/v1/domains');
	if (!result.ok) return result;
	return isDomainPage(result.body)
		? { ok: true, page: result.body }
		: { ok: false, failure: malformed };
}
