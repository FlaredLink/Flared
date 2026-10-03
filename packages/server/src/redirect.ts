// SPDX-License-Identifier: AGPL-3.0-only
// Short-link redirects for every redirect domain. A resolved link is kept in a private Workers
// Cache entry until 60 seconds after its lookup started, so an edit, disable, or block reaches
// every visitor within that bound. Each counted GET sends one minimized click event after the
// response. Imports only routing and contract code.
import type { D1Database } from '@cloudflare/workers-types/index.ts';
import type { ClickEvent } from '@flared/contracts/analytics';
import { slugPattern } from '@flared/contracts/links';
import { isReservedPath } from '@flared/contracts/reserved';
import { findRedirectTarget, isActiveDomain, type RedirectTarget } from '@flared/data/links';
import { buildClickEvent, isAutomated } from './clicks';
import {
	unavailablePage,
	unavailablePageHeaders,
	type UnavailableReason
} from './unavailable-page';

// The click Queue producer, or any sink with the same contract.
export interface ClickSink {
	send(event: ClickEvent): Promise<void>;
}

export interface RedirectDependencies {
	routing: D1Database;
	// The exact application origin from deployment configuration. Reserved paths go there.
	appOrigin: string;
	// The product home that the not-found page links to. Without it, the page has no link.
	homeUrl?: string;
	// A new name discards every snapshot, for example after a routing restore.
	cacheName?: string;
	// Without a sink, redirects work and no click is recorded.
	clicks?: ClickSink;
	now?: () => number;
}

export interface BackgroundWork {
	waitUntil(promise: Promise<unknown>): void;
}

interface Snapshot extends RedirectTarget {
	validUntil: number;
}

export const snapshotLifetimeMs = 60000;

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

// Browsers get a page; other clients keep the plain-text body.
function unavailable(
	request: Request,
	reason: UnavailableReason,
	homeUrl: string | undefined
): Response {
	const status = reason === 'not-found' ? 404 : 503;
	if (!request.headers.get('accept')?.includes('text/html'))
		return plain(request, status, reason === 'not-found' ? 'Not found' : 'Service unavailable', {
			vary: 'Accept'
		});
	return new Response(request.method === 'HEAD' ? null : unavailablePage(reason, homeUrl), {
		status,
		headers: { ...unavailablePageHeaders, 'cache-control': 'no-store', vary: 'Accept' }
	});
}

function redirect(location: string): Response {
	return new Response(null, { status: 302, headers: { location, 'cache-control': 'no-store' } });
}

function toSnapshot(value: unknown): Snapshot | null {
	if (
		typeof value !== 'object' ||
		value === null ||
		!('tenantId' in value && typeof value.tenantId === 'string') ||
		!('linkId' in value && typeof value.linkId === 'string') ||
		!('analyticsShardId' in value && typeof value.analyticsShardId === 'string') ||
		!('destination' in value && typeof value.destination === 'string') ||
		!('validUntil' in value && typeof value.validUntil === 'number')
	)
		return null;
	const { tenantId, linkId, analyticsShardId, destination, validUntil } = value;
	return { tenantId, linkId, analyticsShardId, destination, validUntil };
}

export function createRedirectHandler(dependencies: RedirectDependencies) {
	const now = dependencies.now ?? Date.now;
	// v2: snapshots carry the analytics shard ID.
	const cacheName = dependencies.cacheName ?? 'flared-redirect-v2';

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
			console.error(JSON.stringify({ event: 'redirect_snapshot_store_failed' }));
		}
	}

	// The click never delays or changes the redirect; a failed send is only logged.
	async function recordClick(request: Request, target: RedirectTarget): Promise<void> {
		if (!dependencies.clicks || request.method !== 'GET') return;
		if (isAutomated(request.headers.get('user-agent'))) return;
		try {
			await dependencies.clicks.send(buildClickEvent(request, target, now()));
		} catch {
			console.error(JSON.stringify({ event: 'click_enqueue_failed' }));
		}
	}

	function redirectTo(
		request: Request,
		target: RedirectTarget,
		background: BackgroundWork | undefined,
		work: Promise<unknown>[] = []
	): Promise<Response> | Response {
		const pending = Promise.all([...work, recordClick(request, target)]);
		const response = redirect(target.destination);
		if (background) {
			background.waitUntil(pending);
			return response;
		}
		return pending.then(() => response);
	}

	const notFound = (request: Request) => unavailable(request, 'not-found', dependencies.homeUrl);
	const failed = (request: Request) => unavailable(request, 'unavailable', dependencies.homeUrl);

	async function fetch(request: Request, background?: BackgroundWork): Promise<Response> {
		if (request.method !== 'GET' && request.method !== 'HEAD')
			return plain(request, 405, 'Method not allowed', { allow: 'GET, HEAD' });
		const url = new URL(request.url);
		const hostname = url.hostname.replace(/\.$/, '');

		if (isReservedPath(url.pathname)) {
			let known: boolean;
			try {
				known = await isActiveDomain(dependencies.routing, hostname);
			} catch {
				console.error(JSON.stringify({ event: 'redirect_lookup_failed' }));
				return failed(request);
			}
			if (!known) return notFound(request);
			return redirect(new URL(`${url.pathname}${url.search}`, dependencies.appOrigin).toString());
		}

		const slug = url.pathname.slice(1);
		if (!slugPattern.test(slug)) return notFound(request);

		const key = new Request(`https://${hostname}/${slug}`);
		const cached = await readSnapshot(key);
		if (cached && now() < cached.validUntil) return redirectTo(request, cached, background);

		// The deadline counts from the query start, so a slow read cannot extend it.
		const validUntil = now() + snapshotLifetimeMs;
		let target: RedirectTarget | null;
		try {
			target = await findRedirectTarget(dependencies.routing, hostname, slug);
		} catch {
			console.error(JSON.stringify({ event: 'redirect_lookup_failed' }));
			return failed(request);
		}
		if (!target) return notFound(request);
		if (now() >= validUntil) return failed(request);

		return redirectTo(request, target, background, [storeSnapshot(key, { ...target, validUntil })]);
	}

	return { fetch };
}
