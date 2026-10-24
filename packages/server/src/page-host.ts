// SPDX-License-Identifier: AGPL-3.0-only
// Visitor requests for pages: <handle>.<host> on the edition's page host, and the root of a
// workspace domain (the redirect handler sends those here). The page is at /, its images at
// /_image/<file>. A resolved page is kept in a private Workers Cache entry until 60 seconds after
// its lookup started, so an edit, disable, or block reaches every visitor within that bound;
// block schedules are checked on every request. A counted GET sends one page view after the
// response: never for HEAD, automated clients, or prefetches. An old handle sends visitors to the
// page's new handle for 90 days. Imports only routing and contract code.
import type { D1Database } from '@cloudflare/workers-types/index.ts';
import { previewImageFilePattern, previewImageTypes } from '@flared/contracts/links';
import {
	handlePattern,
	pageBlockKinds,
	pageImagePath,
	parseTheme,
	type PageBlock
} from '@flared/contracts/pages';
import {
	findPageByDomain,
	findPageByHandle,
	type PageBlockRow,
	type PageLookup,
	type PageTarget
} from '@flared/data/pages';
import { buildPageViewEvent, isAutomated } from './clicks';
import { pageImageKey, type PageImageStore } from './page-images';
import { renderPage } from './page-render';
import { blockOf } from './pages';
import type { BackgroundWork, ClickSink } from './redirect';
import {
	unavailablePage,
	unavailablePageHeaders,
	type PageUnavailableReason
} from './unavailable-page';

export interface PageHostDependencies {
	routing: D1Database;
	// The host that serves pages at <handle>.<host>, such as flared.site. Without it, pages show
	// only at the root of workspace domains.
	host?: string;
	// The badge links here. Without it, the badge is plain text.
	homeUrl?: string;
	// Where a visitor reports abuse. The blocked page links to it.
	reportUrl?: string;
	// A new name discards every snapshot.
	cacheName?: string;
	// Without a sink, pages show and no view is recorded.
	views?: ClickSink;
	// Without it, page images are not found; the page shows without them.
	images?: PageImageStore;
	// A single-workspace installation's tenant. A page of any other tenant is not found.
	fixedTenantId?: string;
	now?: () => number;
}

export interface PageHandler {
	fetch(request: Request, background?: BackgroundWork): Promise<Response>;
}

interface Snapshot extends PageTarget {
	validUntil: number;
}

export const pageSnapshotLifetimeMs = 60000;

const statuses: Record<PageUnavailableReason, number> = {
	'page-not-found': 404,
	'page-blocked': 410,
	'page-unavailable': 503
};
const plainText: Record<PageUnavailableReason, string> = {
	'page-not-found': 'Not found',
	'page-blocked': 'Page blocked',
	'page-unavailable': 'Service unavailable'
};

function plain(
	request: Request,
	status: number,
	body: string,
	headers: Record<string, string> = {}
) {
	return new Response(request.method === 'HEAD' ? null : body, {
		status,
		headers: {
			'content-type': 'text/plain; charset=utf-8',
			'cache-control': 'no-store',
			...headers
		}
	});
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value: unknown) => value === null || typeof value === 'string';
const isTime = (value: unknown) =>
	value === null || (typeof value === 'number' && Number.isSafeInteger(value));

function isBlockRow(value: unknown): value is PageBlockRow {
	if (!isRecord(value)) return false;
	const link = value.link;
	return (
		typeof value.position === 'number' &&
		(pageBlockKinds as readonly unknown[]).includes(value.kind) &&
		isText(value.linkId) &&
		isText(value.label) &&
		(value.data === null || isRecord(value.data)) &&
		isTime(value.startsAt) &&
		isTime(value.endsAt) &&
		(link === null ||
			(isRecord(link) &&
				typeof link.shortUrl === 'string' &&
				typeof link.destination === 'string' &&
				typeof link.open === 'boolean'))
	);
}

function toSnapshot(value: unknown): Snapshot | null {
	if (
		!isRecord(value) ||
		typeof value.tenantId !== 'string' ||
		typeof value.pageId !== 'string' ||
		typeof value.analyticsShardId !== 'string' ||
		typeof value.handle !== 'string' ||
		typeof value.title !== 'string' ||
		!isText(value.domainHostname) ||
		!isText(value.bio) ||
		!isText(value.avatarImage) ||
		!isText(value.backgroundImage) ||
		!isRecord(value.theme) ||
		typeof value.theme.id !== 'string' ||
		typeof value.badge !== 'boolean' ||
		!Array.isArray(value.blocks) ||
		!value.blocks.every(isBlockRow) ||
		typeof value.validUntil !== 'number'
	)
		return null;
	// Every field of a snapshot is checked above.
	return value as unknown as Snapshot;
}

// A stored theme that fails the input rules shows as the default theme.
function safeTheme(theme: PageTarget['theme']) {
	try {
		return parseTheme(theme);
	} catch {
		return parseTheme(undefined);
	}
}

function scheduled(block: PageBlock, time: number): boolean {
	const starts = block.startsAt === null ? null : Date.parse(block.startsAt);
	const ends = block.endsAt === null ? null : Date.parse(block.endsAt);
	return (starts === null || time >= starts) && (ends === null || time < ends);
}

type Address = { kind: 'handle'; handle: string } | { kind: 'domain'; hostname: string };

export function createPageHandler(dependencies: PageHostDependencies): PageHandler {
	const now = dependencies.now ?? Date.now;
	const cacheName = dependencies.cacheName ?? 'flared-page-v1';
	const links = { homeUrl: dependencies.homeUrl, reportUrl: dependencies.reportUrl };

	function unavailable(request: Request, reason: PageUnavailableReason): Response {
		const status = statuses[reason];
		if (!request.headers.get('accept')?.includes('text/html'))
			return plain(request, status, plainText[reason], { vary: 'Accept' });
		return new Response(request.method === 'HEAD' ? null : unavailablePage(reason, links), {
			status,
			headers: { ...unavailablePageHeaders, 'cache-control': 'no-store', vary: 'Accept' }
		});
	}
	const notFound = (request: Request) => unavailable(request, 'page-not-found');
	const failed = (request: Request) => unavailable(request, 'page-unavailable');

	// The handle of <handle>.<host>, or the hostname of any other host. The page host itself and a
	// label that is not a handle have no page.
	function addressOf(hostname: string): Address | null {
		const host = dependencies.host;
		if (host && hostname === host) return null;
		if (host && hostname.endsWith(`.${host}`)) {
			const handle = hostname.slice(0, -host.length - 1);
			return handlePattern.test(handle) ? { kind: 'handle', handle } : null;
		}
		return { kind: 'domain', hostname };
	}

	// A cache fault only costs a database read, so it counts as a miss.
	async function readSnapshot(key: Request): Promise<Snapshot | null> {
		try {
			const hit = await (await caches.open(cacheName)).match(key);
			return hit ? toSnapshot(await hit.json()) : null;
		} catch {
			return null;
		}
	}

	async function storeSnapshot(key: Request, snapshot: Snapshot): Promise<void> {
		const seconds = Math.floor((snapshot.validUntil - now()) / 1000);
		if (seconds < 1) return;
		try {
			const entry = new Response(JSON.stringify(snapshot), {
				headers: { 'content-type': 'application/json', 'cache-control': `max-age=${seconds}` }
			});
			await (await caches.open(cacheName)).put(key, entry);
		} catch {
			console.error(JSON.stringify({ event: 'page_snapshot_store_failed' }));
		}
	}

	function settle(
		response: Response,
		background: BackgroundWork | undefined,
		work: Promise<unknown>[]
	): Promise<Response> | Response {
		if (work.length === 0) return response;
		const pending = Promise.all(work);
		if (background) {
			background.waitUntil(pending);
			return response;
		}
		return pending.then(() => response);
	}

	const foreign = (page: PageTarget) =>
		dependencies.fixedTenantId !== undefined && page.tenantId !== dependencies.fixedTenantId;

	// The page at an address, from its snapshot or the database, or the response that ends the
	// request. A moved handle answers only at the root.
	async function resolve(
		request: Request,
		hostname: string,
		address: Address,
		root: boolean
	): Promise<{ page: PageTarget; work: Promise<unknown>[] } | Response> {
		const key = new Request(`https://${hostname}/`);
		const cached = await readSnapshot(key);
		if (cached && now() < cached.validUntil)
			return foreign(cached) ? notFound(request) : { page: cached, work: [] };

		const validUntil = now() + pageSnapshotLifetimeMs;
		let lookup: PageLookup | null;
		try {
			lookup =
				address.kind === 'handle'
					? await findPageByHandle(dependencies.routing, address.handle, now())
					: await findPageByDomain(dependencies.routing, address.hostname);
		} catch {
			console.error(JSON.stringify({ event: 'page_lookup_failed' }));
			return failed(request);
		}
		// None of these is cached, so an unblock, a new page, or a new handle shows at once.
		if (!lookup) return notFound(request);
		if (lookup.kind === 'blocked') return unavailable(request, 'page-blocked');
		if (lookup.kind === 'moved') {
			if (!root || !dependencies.host) return notFound(request);
			return new Response(null, {
				status: 302,
				headers: {
					location: `https://${lookup.handle}.${dependencies.host}/`,
					'cache-control': 'no-store'
				}
			});
		}
		if (now() >= validUntil) return failed(request);
		const { page } = lookup;
		if (foreign(page)) return notFound(request);
		return { page, work: [storeSnapshot(key, { ...page, validUntil })] };
	}

	// A GET from a person counts. HEAD, automated clients, and prefetches send no view.
	async function recordView(request: Request, page: PageTarget): Promise<void> {
		const purpose = `${request.headers.get('sec-purpose') ?? ''} ${request.headers.get('purpose') ?? ''}`;
		if (
			!dependencies.views ||
			request.method !== 'GET' ||
			isAutomated(request.headers.get('user-agent')) ||
			/prefetch|prerender/i.test(purpose)
		)
			return;
		try {
			await dependencies.views.send(buildPageViewEvent(request, page, now()));
		} catch {
			console.error(JSON.stringify({ event: 'page_view_enqueue_failed' }));
		}
	}

	function show(
		request: Request,
		hostname: string,
		page: PageTarget,
		background: BackgroundWork | undefined,
		work: Promise<unknown>[]
	): Promise<Response> | Response {
		const time = now();
		const origin = `https://${hostname}`;
		// A page on a workspace domain names that domain as its address on every host.
		const url = page.domainHostname ? `https://${page.domainHostname}/` : `${origin}/`;
		const image = (file: string | null) =>
			file !== null && dependencies.images ? `${origin}${pageImagePath(file)}` : null;
		const blocks = page.blocks
			.map(blockOf)
			.filter((block) => block.visible && scheduled(block, time));
		const { html, contentSecurityPolicy } = renderPage({
			title: page.title,
			bio: page.bio,
			theme: safeTheme(page.theme),
			url,
			avatarUrl: image(page.avatarImage),
			backgroundUrl: image(page.backgroundImage),
			blocks,
			badge: page.badge,
			homeUrl: dependencies.homeUrl
		});
		const response = new Response(request.method === 'HEAD' ? null : html, {
			headers: {
				'content-type': 'text/html; charset=utf-8',
				'content-security-policy': contentSecurityPolicy,
				'x-content-type-options': 'nosniff',
				'referrer-policy': 'strict-origin-when-cross-origin',
				'cache-control': 'no-cache'
			}
		});
		return settle(response, background, [...work, recordView(request, page)]);
	}

	// Any stored image of the page is served while the page shows, not only the snapshot's name, so
	// a new image works during the snapshot window. A replaced image is deleted from the store.
	async function serveImage(
		request: Request,
		page: PageTarget,
		file: string,
		background: BackgroundWork | undefined,
		work: Promise<unknown>[]
	): Promise<Response> {
		const store = dependencies.images;
		if (!store) return settle(notFound(request), background, work);
		let object: Awaited<ReturnType<PageImageStore['get']>>;
		try {
			object = await store.get(pageImageKey(page.tenantId, page.pageId, file));
		} catch {
			console.error(JSON.stringify({ event: 'page_image_read_failed' }));
			return settle(failed(request), background, work);
		}
		if (!object) return settle(notFound(request), background, work);
		if (request.method === 'HEAD') await object.body.cancel();
		// previewImageFilePattern matched the name, so its extension is a key of previewImageTypes.
		const extension = file.slice(file.lastIndexOf('.') + 1) as keyof typeof previewImageTypes;
		return settle(
			new Response(request.method === 'HEAD' ? null : object.body, {
				headers: {
					'content-type': previewImageTypes[extension],
					'content-length': String(object.size),
					'cache-control': 'public, max-age=3600',
					'content-security-policy': "default-src 'none'",
					'x-content-type-options': 'nosniff',
					'cross-origin-resource-policy': 'cross-origin'
				}
			}),
			background,
			work
		);
	}

	async function fetch(request: Request, background?: BackgroundWork): Promise<Response> {
		if (request.method !== 'GET' && request.method !== 'HEAD')
			return plain(request, 405, 'Method not allowed', { allow: 'GET, HEAD' });
		const url = new URL(request.url);
		const hostname = url.hostname.replace(/\.$/, '').toLowerCase();
		const address = addressOf(hostname);
		if (!address) return notFound(request);
		const root = url.pathname === '/';
		const image = /^\/_image\/([^/]+)$/.exec(url.pathname);
		if (!root && !(image && previewImageFilePattern.test(image[1]))) return notFound(request);
		const resolved = await resolve(request, hostname, address, root);
		if (resolved instanceof Response) return resolved;
		const { page, work } = resolved;
		if (image) return serveImage(request, page, image[1], background, work);
		return show(request, hostname, page, background, work);
	}

	return { fetch };
}
