// SPDX-License-Identifier: AGPL-3.0-only
// Short-link redirects for every redirect domain. A resolved link is kept in a private Workers
// Cache entry until 60 seconds after its lookup started, so an edit, disable, or block reaches
// every visitor within that bound. Imports only routing and contract code.
import type { D1Database } from '@cloudflare/workers-types/index.ts';
import { slugPattern } from '@flared/contracts/links';
import { isReservedPath } from '@flared/contracts/reserved';
import { findRedirectTarget, isActiveDomain, type RedirectTarget } from '@flared/data/links';

export interface RedirectDependencies {
	routing: D1Database;
	// The exact application origin from deployment configuration. Reserved paths go there.
	appOrigin: string;
	// A new name discards every snapshot, for example after a routing restore.
	cacheName?: string;
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

function redirect(location: string): Response {
	return new Response(null, { status: 302, headers: { location, 'cache-control': 'no-store' } });
}

function toSnapshot(value: unknown): Snapshot | null {
	if (
		typeof value !== 'object' ||
		value === null ||
		!('tenantId' in value && typeof value.tenantId === 'string') ||
		!('linkId' in value && typeof value.linkId === 'string') ||
		!('destination' in value && typeof value.destination === 'string') ||
		!('validUntil' in value && typeof value.validUntil === 'number')
	)
		return null;
	const { tenantId, linkId, destination, validUntil } = value;
	return { tenantId, linkId, destination, validUntil };
}

export function createRedirectHandler(dependencies: RedirectDependencies) {
	const now = dependencies.now ?? Date.now;
	const cacheName = dependencies.cacheName ?? 'flared-redirect-v1';

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
				return plain(request, 503, 'Service unavailable');
			}
			if (!known) return plain(request, 404, 'Not found');
			return redirect(new URL(`${url.pathname}${url.search}`, dependencies.appOrigin).toString());
		}

		const slug = url.pathname.slice(1);
		if (!slugPattern.test(slug)) return plain(request, 404, 'Not found');

		const key = new Request(`https://${hostname}/${slug}`);
		const cached = await readSnapshot(key);
		if (cached && now() < cached.validUntil) return redirect(cached.destination);

		// The deadline counts from the query start, so a slow read cannot extend it.
		const validUntil = now() + snapshotLifetimeMs;
		let target: RedirectTarget | null;
		try {
			target = await findRedirectTarget(dependencies.routing, hostname, slug);
		} catch {
			console.error(JSON.stringify({ event: 'redirect_lookup_failed' }));
			return plain(request, 503, 'Service unavailable');
		}
		if (!target) return plain(request, 404, 'Not found');
		if (now() >= validUntil) return plain(request, 503, 'Service unavailable');

		const stored = storeSnapshot(key, { ...target, validUntil });
		if (background) background.waitUntil(stored);
		else await stored;
		return redirect(target.destination);
	}

	return { fetch };
}
