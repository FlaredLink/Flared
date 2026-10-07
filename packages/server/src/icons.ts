// SPDX-License-Identifier: AGPL-3.0-only
// Site icons: fetched from the site itself, kept in one store for every workspace, and served
// from the app's own origin, so a viewer's browser never contacts the site or a third party.
import { iconHostname } from '@flared/contracts/icons';

// Each request has 3 seconds; one icon lookup, with its redirects and fallbacks, has 8.
export const iconFetchTimeoutMs = 3000;
export const iconLookupTimeoutMs = 8000;
export const iconMaxBytes = 100 * 1024;
// A found icon is fetched again after 30 days; a site without one is asked again after 7.
export const iconFreshMs = 30 * 86400000;
export const iconMissingMs = 7 * 86400000;
const maxRedirects = 3;

export type IconType =
	'image/x-icon' | 'image/png' | 'image/gif' | 'image/jpeg' | 'image/webp' | 'image/svg+xml';

export type StoredIcon =
	| { status: 'found'; type: IconType; body: Uint8Array; fetchedAt: number }
	| { status: 'missing'; fetchedAt: number };

// Cloud keeps icons in R2; a self-hosted install uses the Workers Cache API.
export interface IconStore {
	get(hostname: string): Promise<StoredIcon | null>;
	put(hostname: string, icon: StoredIcon): Promise<void>;
}

export type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

// The type comes from the first bytes: many servers label favicon.ico as text or octet-stream.
// Anything else, HTML included, is not an icon.
export function sniffIcon(bytes: Uint8Array): IconType | null {
	const starts = (...values: number[]) => values.every((value, index) => bytes[index] === value);
	if (starts(0, 0, 1, 0)) return 'image/x-icon';
	if (starts(0x89, 0x50, 0x4e, 0x47)) return 'image/png';
	if (starts(0x47, 0x49, 0x46, 0x38)) return 'image/gif';
	if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
	if (starts(0x52, 0x49, 0x46, 0x46) && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP')
		return 'image/webp';
	const head = new TextDecoder().decode(bytes.slice(0, 512)).replace(/^﻿/, '').trimStart();
	if (
		/^(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)
	)
		return 'image/svg+xml';
	return null;
}

// Reads at most limit bytes. An image longer than that is refused; a page is cut, because its
// icon links are in the head near the start.
async function readLimited(
	response: Response,
	limit: number,
	overflow: 'refuse' | 'cut'
): Promise<Uint8Array | null> {
	const declared = Number(response.headers.get('content-length'));
	if (overflow === 'refuse' && Number.isFinite(declared) && declared > limit) {
		await response.body?.cancel();
		return null;
	}
	if (!response.body) return new Uint8Array();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (size + value.byteLength > limit) {
			await reader.cancel();
			if (overflow === 'refuse') return null;
			chunks.push(value.slice(0, limit - size));
			size = limit;
			break;
		}
		size += value.byteLength;
		chunks.push(value);
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

// Only HTTPS on the default port to a public host name; redirects are followed by hand so that
// every hop passes the same check.
function allowedUrl(value: string, base?: string): URL | null {
	let url: URL;
	try {
		url = new URL(value, base);
	} catch {
		return null;
	}
	if (url.protocol !== 'https:' || url.port !== '' || url.username || url.password) return null;
	return iconHostname(url.hostname) ? url : null;
}

async function fetchLimited(
	fetcher: Fetcher,
	start: URL,
	accept: string,
	signal: AbortSignal
): Promise<{ url: URL; bytes: Uint8Array; type: string } | null> {
	let url = start;
	for (let hop = 0; hop <= maxRedirects; hop += 1) {
		const response = await fetcher(url.href, {
			redirect: 'manual',
			signal: AbortSignal.any([signal, AbortSignal.timeout(iconFetchTimeoutMs)]),
			headers: { accept, 'user-agent': 'FlaredIconFetcher/1.0 (+https://flared.page)' }
		});
		if (response.status >= 300 && response.status < 400) {
			await response.body?.cancel();
			const next = allowedUrl(response.headers.get('location') ?? '', url.href);
			if (!next) return null;
			url = next;
			continue;
		}
		if (response.status !== 200) {
			await response.body?.cancel();
			return null;
		}
		const bytes = await readLimited(
			response,
			iconMaxBytes,
			accept === 'text/html' ? 'cut' : 'refuse'
		);
		if (!bytes) return null;
		return { url, bytes, type: response.headers.get('content-type') ?? '' };
	}
	return null;
}

// The icon links of a home page, in the order a browser would try them.
export function iconLinks(html: string): string[] {
	const icons: string[] = [];
	const touch: string[] = [];
	for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
		const attribute = (name: string) =>
			new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i')
				.exec(tag)
				?.slice(1)
				.find((part) => part !== undefined);
		const rel = attribute('rel')?.toLowerCase().split(/\s+/) ?? [];
		const href = attribute('href')?.trim();
		if (!href) continue;
		if (rel.includes('icon')) icons.push(href);
		else if (rel.includes('apple-touch-icon')) touch.push(href);
	}
	return [...icons, ...touch];
}

function decodeHtmlEntities(value: string): string {
	return value
		.replace(/&amp;/g, '&')
		.replace(/&#x2f;/gi, '/')
		.replace(/&#47;/g, '/');
}

// /favicon.ico first, then the icon links of the home page. The cache key has no "www.", so a
// host that cannot be reached is tried again with it (some names resolve only with "www.").
// Returns a missing record when the site has no usable icon within the limits; throws nothing
// for the site's own failures.
export async function fetchIcon(
	hostname: string,
	fetcher: Fetcher,
	now: number
): Promise<StoredIcon> {
	const missing: StoredIcon = { status: 'missing', fetchedAt: now };
	const deadline = AbortSignal.timeout(iconLookupTimeoutMs);
	// Set by any response, a redirect included: then the host exists and "www." is not tried.
	let reached = false;
	const counted: Fetcher = async (input, init) => {
		const response = await fetcher(input, init);
		reached = true;
		return response;
	};
	const icon = async (url: URL): Promise<StoredIcon | null> => {
		const result = await fetchLimited(counted, url, 'image/*', deadline);
		const type = result && result.bytes.byteLength > 0 ? sniffIcon(result.bytes) : null;
		return result && type ? { status: 'found', type, body: result.bytes, fetchedAt: now } : null;
	};
	const fromOrigin = async (origin: URL): Promise<StoredIcon | null> => {
		const favicon = await icon(new URL('/favicon.ico', origin));
		if (favicon) return favicon;
		const page = await fetchLimited(counted, origin, 'text/html', deadline);
		if (!page || !/text\/html|application\/xhtml/i.test(page.type)) return null;
		const html = new TextDecoder().decode(page.bytes);
		for (const href of iconLinks(html).slice(0, 3)) {
			const url = allowedUrl(decodeHtmlEntities(href), page.url.href);
			if (!url) continue;
			const linked = await icon(url).catch(() => null);
			if (linked) return linked;
		}
		return null;
	};
	const origins = [`https://${hostname}/`, `https://www.${hostname}/`]
		.map((value) => allowedUrl(value))
		.filter((origin) => origin !== null);
	for (const origin of origins) {
		try {
			return (await fromOrigin(origin)) ?? missing;
		} catch {
			if (reached || deadline.aborted) return missing;
		}
	}
	return missing;
}

// A stored icon within its lifetime is used as it is. A stale or absent one is fetched when
// mayFetch allows it (the caller's rate limit); otherwise the stale record, if any, is used. A
// found icon is kept when a new attempt finds nothing, so a site's bad day does not erase it.
export async function resolveIcon(
	store: IconStore,
	hostname: string,
	fetcher: Fetcher,
	now: number,
	mayFetch: () => Promise<boolean> = async () => true
): Promise<StoredIcon | null> {
	const stored = await store.get(hostname);
	if (stored) {
		const lifetime = stored.status === 'found' ? iconFreshMs : iconMissingMs;
		if (now - stored.fetchedAt < lifetime) return stored;
	}
	if (!(await mayFetch())) return stored;
	const fresh = await fetchIcon(hostname, fetcher, now);
	const icon =
		fresh.status === 'missing' && stored?.status === 'found'
			? { ...stored, fetchedAt: now }
			: fresh;
	await store.put(hostname, icon);
	return icon;
}

// Headers for an icon sent to the dashboard. An SVG can carry script, so it is served with a
// sandbox that allows nothing but inline styles, even when opened directly.
export function iconHeaders(type: IconType): Headers {
	const headers = new Headers({
		'content-type': type,
		'cache-control': 'private, max-age=86400',
		'x-content-type-options': 'nosniff'
	});
	if (type === 'image/svg+xml')
		headers.set(
			'content-security-policy',
			"default-src 'none'; style-src 'unsafe-inline'; sandbox"
		);
	return headers;
}

const iconTypes: readonly IconType[] = [
	'image/x-icon',
	'image/png',
	'image/gif',
	'image/jpeg',
	'image/webp',
	'image/svg+xml'
];

function storedRecord(
	status: unknown,
	fetchedAt: unknown,
	type: unknown,
	body: Uint8Array
): StoredIcon | null {
	const time = Number(fetchedAt);
	if (!Number.isSafeInteger(time) || time < 0) return null;
	if (status === 'missing') return { status, fetchedAt: time };
	const known = iconTypes.find((item) => item === type);
	if (status !== 'found' || !known || body.byteLength === 0) return null;
	return { status, type: known, body, fetchedAt: time };
}

// The parts of an R2 bucket the store uses.
export interface IconBucket {
	get(key: string): Promise<{
		customMetadata?: Record<string, string>;
		arrayBuffer(): Promise<ArrayBuffer>;
	} | null>;
	put(
		key: string,
		value: Uint8Array,
		options: { customMetadata: Record<string, string> }
	): Promise<unknown>;
}

// One object per host name: the icon bytes, or an empty body for a site without an icon.
export function r2IconStore(bucket: IconBucket): IconStore {
	const key = (hostname: string) => `icons/v1/${hostname}`;
	return {
		async get(hostname) {
			const object = await bucket.get(key(hostname));
			if (!object) return null;
			const meta = object.customMetadata ?? {};
			return storedRecord(
				meta.status,
				meta.fetchedAt,
				meta.type,
				new Uint8Array(await object.arrayBuffer())
			);
		},
		async put(hostname, icon) {
			await bucket.put(key(hostname), icon.status === 'found' ? icon.body : new Uint8Array(), {
				customMetadata: {
					status: icon.status,
					fetchedAt: String(icon.fetchedAt),
					...(icon.status === 'found' ? { type: icon.type } : {})
				}
			});
		}
	};
}

// The parts of a Workers cache the store uses.
export interface IconCache {
	match(request: string): Promise<Response | undefined>;
	put(request: string, response: Response): Promise<void>;
}

// The Cache API keeps entries per data centre and may evict them early; a lost entry only costs
// one more fetch from the site. Entries live past their refresh time so a stale icon can stay.
export function cacheIconStore(cache: IconCache): IconStore {
	const key = (hostname: string) => `https://icons.flared.invalid/v1/${hostname}`;
	return {
		async get(hostname) {
			const response = await cache.match(key(hostname));
			if (!response) return null;
			return storedRecord(
				response.headers.get('x-icon-status'),
				response.headers.get('x-icon-fetched-at'),
				response.headers.get('content-type'),
				new Uint8Array(await response.arrayBuffer())
			);
		},
		async put(hostname, icon) {
			const lifetime = icon.status === 'found' ? 3 * iconFreshMs : iconMissingMs;
			const headers = new Headers({
				'cache-control': `max-age=${Math.floor(lifetime / 1000)}`,
				'x-icon-status': icon.status,
				'x-icon-fetched-at': String(icon.fetchedAt)
			});
			if (icon.status === 'found') headers.set('content-type', icon.type);
			await cache.put(
				key(hostname),
				new Response(icon.status === 'found' ? icon.body : null, { headers })
			);
		}
	};
}

// A store in the named Workers cache, opened on use.
export function workersCacheIconStore(name = 'flared-icons'): IconStore {
	return cacheIconStore({
		match: async (request) => (await caches.open(name)).match(request),
		put: async (request, response) => (await caches.open(name)).put(request, response)
	});
}
