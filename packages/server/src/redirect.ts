// SPDX-License-Identifier: AGPL-3.0-only
// Short-link redirects for every redirect domain. A resolved link is kept in a private Workers
// Cache entry until 60 seconds after its lookup started, so an edit, disable, or block reaches
// every visitor within that bound. Each counted GET sends one minimized click event after the
// response. iPhone and Android visitors go to the link's device destination when it has one;
// automated clients always get the destination, so link previews show the web page. For a
// workspace that forwards its clicks, a counted GET also reads or sets the host-only visitor
// cookie, unless the request sends Sec-GPC: 1; a response that sets it is private. A link with a
// start or end time opens only between them; after the end, visitors go to the destination for
// after the end, which counts no click. A link with a password shows a form; a correct POST of
// it answers 303 to the visitor's location and counts the click. A link with a social preview
// gives card bots a page with its card tags and serves its image at /<slug>/preview/<file>.
// Imports only routing and contract code.
import type { D1Database } from '@cloudflare/workers-types/index.ts';
import { visitorIdPattern, type ClickEvent } from '@flared/contracts/analytics';
import {
	maxLinkPasswordLength,
	previewImageFilePattern,
	previewImagePath,
	previewImageTypes,
	slugPattern
} from '@flared/contracts/links';
import { isReservedPath } from '@flared/contracts/reserved';
import { activeDomainKind } from '@flared/data/domains';
import { findRedirectTarget, type RedirectLookup, type RedirectTarget } from '@flared/data/links';
import { buildClickEvent, isAutomated, osFamily, type ForwardContext } from './clicks';
import type { LinkPasswords } from './link-passwords';
import { isCardFetcher, linkCardHeaders, linkCardPage } from './link-previews';
import { previewImageKey, type PreviewImageStore } from './preview-images';
import {
	passwordPage,
	passwordPageHeaders,
	unavailablePage,
	unavailablePageHeaders,
	type PasswordPageError,
	type UnavailableReason
} from './unavailable-page';

// The click Queue producer, or any sink with the same contract.
export interface ClickSink {
	send(event: ClickEvent): Promise<void>;
}

// The Workers Rate Limiting binding, or any limiter with the same contract.
export interface AttemptLimiter {
	limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface RedirectDependencies {
	routing: D1Database;
	// The exact application origin from deployment configuration. Reserved paths go there.
	appOrigin: string;
	// The product home that the not-found page links to. Without it, the page has no link.
	homeUrl?: string;
	// Where a visitor reports abuse. The blocked page links to it; without it, it has no link.
	reportUrl?: string;
	// A new name discards every snapshot, for example after a routing restore.
	cacheName?: string;
	// Without a sink, redirects work and no click is recorded.
	clicks?: ClickSink;
	// A single-workspace installation's tenant. A link of any other tenant is not found.
	fixedTenantId?: string;
	// The installation's link password key and a limit on tries for each link and visitor IP.
	// Without them, a link that has a password does not open.
	linkPasswords?: { keys: LinkPasswords; attempts: AttemptLimiter };
	// Where uploaded preview images are kept. Without it, a preview image is not found; the
	// preview texts still work.
	previewImages?: PreviewImageStore;
	now?: () => number;
}

export interface BackgroundWork {
	waitUntil(promise: Promise<unknown>): void;
}

interface Snapshot extends RedirectTarget {
	validUntil: number;
}

export const snapshotLifetimeMs = 60000;

// A form body of one password: 128 characters, each up to 4 UTF-8 bytes and 3 characters encoded.
const maxFormBytes = 2048;

export const visitorCookieName = 'flared_vid';
export const visitorCookieMaxAgeSeconds = 31536000;

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

const statuses: Record<UnavailableReason, { status: number; text: string }> = {
	'not-found': { status: 404, text: 'Not found' },
	blocked: { status: 410, text: 'Link blocked' },
	unavailable: { status: 503, text: 'Service unavailable' },
	'not-open': { status: 404, text: 'Link not open yet' },
	ended: { status: 410, text: 'Link ended' }
};

// Browsers get a page; other clients keep the plain-text body.
function unavailable(
	request: Request,
	reason: UnavailableReason,
	links: { homeUrl?: string; reportUrl?: string }
): Response {
	const { status, text } = statuses[reason];
	if (!request.headers.get('accept')?.includes('text/html'))
		return plain(request, status, text, { vary: 'Accept' });
	return new Response(request.method === 'HEAD' ? null : unavailablePage(reason, links), {
		status,
		headers: { ...unavailablePageHeaders, 'cache-control': 'no-store', vary: 'Accept' }
	});
}

function redirect(location: string, headers: Record<string, string> = {}, status = 302): Response {
	return new Response(null, {
		status,
		headers: { location, 'cache-control': 'no-store', ...headers }
	});
}

function passwordForm(
	request: Request,
	status: number,
	error: PasswordPageError | null,
	links: { homeUrl?: string },
	headers: Record<string, string> = {}
): Response {
	if (!request.headers.get('accept')?.includes('text/html'))
		return plain(request, status, 'Password required', { vary: 'Accept', ...headers });
	return new Response(request.method === 'HEAD' ? null : passwordPage(error, links), {
		status,
		headers: { ...passwordPageHeaders, 'cache-control': 'no-store', vary: 'Accept', ...headers }
	});
}

// The password field of a form POST, or null for any other body. Reads at most maxFormBytes.
async function readPassword(request: Request): Promise<string | null> {
	const type = request.headers.get('content-type')?.toLowerCase() ?? '';
	if (!type.startsWith('application/x-www-form-urlencoded')) return null;
	if (Number(request.headers.get('content-length') ?? '0') > maxFormBytes) return null;
	const reader = request.body?.getReader();
	if (!reader) return null;
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > maxFormBytes) {
			await reader.cancel();
			return null;
		}
		chunks.push(value);
	}
	const body = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	const password = new URLSearchParams(new TextDecoder().decode(body)).get('password');
	return password && password.length <= maxLinkPasswordLength ? password : null;
}

// The location for this visitor. A link with a device destination varies by user agent.
function targetLocation(
	request: Request,
	target: RedirectTarget
): { location: string; varies: boolean } {
	if (target.iosDestination === null && target.androidDestination === null)
		return { location: target.destination, varies: false };
	const agent = request.headers.get('user-agent');
	const os = isAutomated(agent) ? null : osFamily(agent);
	const device =
		os === 'ios' ? target.iosDestination : os === 'android' ? target.androidDestination : null;
	return { location: device ?? target.destination, varies: true };
}

function globalPrivacyControl(request: Request): boolean {
	return request.headers.get('sec-gpc')?.trim() === '1';
}

// The first well-formed visitor cookie value; any other value is ignored.
function visitorCookie(request: Request): string | null {
	for (const part of (request.headers.get('cookie') ?? '').split(';')) {
		const separator = part.indexOf('=');
		if (separator < 0 || part.slice(0, separator).trim() !== visitorCookieName) continue;
		const value = part.slice(separator + 1).trim();
		if (visitorIdPattern.test(value)) return value;
	}
	return null;
}

function newVisitorId(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
}

function optionalText(value: unknown): string | null | undefined {
	return value === null || typeof value === 'string' ? value : undefined;
}

function optionalTime(value: unknown): number | null | undefined {
	return value === null || (typeof value === 'number' && Number.isSafeInteger(value))
		? value
		: undefined;
}

function toSnapshot(value: unknown): Snapshot | null {
	if (
		typeof value !== 'object' ||
		value === null ||
		!('tenantId' in value && typeof value.tenantId === 'string') ||
		!('linkId' in value && typeof value.linkId === 'string') ||
		!('analyticsShardId' in value && typeof value.analyticsShardId === 'string') ||
		!('destination' in value && typeof value.destination === 'string') ||
		!('iosDestination' in value) ||
		!('androidDestination' in value) ||
		!('startsAt' in value) ||
		!('endsAt' in value) ||
		!('endedDestination' in value) ||
		!('passwordHash' in value) ||
		!('title' in value) ||
		!('previewTitle' in value) ||
		!('previewDescription' in value) ||
		!('previewImage' in value) ||
		!('forwardClicks' in value && typeof value.forwardClicks === 'boolean') ||
		!('validUntil' in value && typeof value.validUntil === 'number')
	)
		return null;
	const iosDestination = optionalText(value.iosDestination);
	const androidDestination = optionalText(value.androidDestination);
	const startsAt = optionalTime(value.startsAt);
	const endsAt = optionalTime(value.endsAt);
	const endedDestination = optionalText(value.endedDestination);
	const passwordHash = optionalText(value.passwordHash);
	const title = optionalText(value.title);
	const previewTitle = optionalText(value.previewTitle);
	const previewDescription = optionalText(value.previewDescription);
	const previewImage = optionalText(value.previewImage);
	if (
		iosDestination === undefined ||
		androidDestination === undefined ||
		startsAt === undefined ||
		endsAt === undefined ||
		endedDestination === undefined ||
		passwordHash === undefined ||
		title === undefined ||
		previewTitle === undefined ||
		previewDescription === undefined ||
		previewImage === undefined
	)
		return null;
	const { tenantId, linkId, analyticsShardId, destination, forwardClicks, validUntil } = value;
	return {
		tenantId,
		linkId,
		analyticsShardId,
		destination,
		iosDestination,
		androidDestination,
		startsAt,
		endsAt,
		endedDestination,
		passwordHash,
		title,
		previewTitle,
		previewDescription,
		previewImage,
		forwardClicks,
		validUntil
	};
}

function hasPreview(target: RedirectTarget): boolean {
	return (
		target.previewTitle !== null ||
		target.previewDescription !== null ||
		target.previewImage !== null
	);
}

export function createRedirectHandler(dependencies: RedirectDependencies) {
	const now = dependencies.now ?? Date.now;
	// v2: snapshots carry the analytics shard ID. v3: and the device destinations. v4: and the
	// click forwarding flag. v5: and the dates, the destination after the end, and the password
	// hash. v6: and the title and the social preview.
	const cacheName = dependencies.cacheName ?? 'flared-redirect-v6';

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

	// A GET, or the POST that unlocks a link, counts. HEAD, other methods, and automated clients
	// send no event, so they never get the cookie.
	function counts(request: Request, unlocked: boolean): boolean {
		return (
			dependencies.clicks !== undefined &&
			(request.method === 'GET' || unlocked) &&
			!isAutomated(request.headers.get('user-agent'))
		);
	}

	// The click never delays or changes the redirect; a failed send is only logged.
	async function recordClick(
		request: Request,
		target: RedirectTarget,
		context: ForwardContext | undefined,
		unlocked: boolean
	): Promise<void> {
		if (!dependencies.clicks || !counts(request, unlocked)) return;
		try {
			await dependencies.clicks.send(buildClickEvent(request, target, now(), context));
		} catch {
			console.error(JSON.stringify({ event: 'click_enqueue_failed' }));
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

	// unlocked: the request is the POST of a correct password; it answers 303 so the browser
	// follows with a GET.
	function redirectTo(
		request: Request,
		target: RedirectTarget,
		address: { hostname: string; slug: string },
		background: BackgroundWork | undefined,
		work: Promise<unknown>[],
		unlocked = false
	): Promise<Response> | Response {
		const { location, varies } = targetLocation(request, target);
		// A card bot gets the card instead, so a link with a preview varies too.
		const headers: Record<string, string> =
			varies || hasPreview(target) ? { vary: 'User-Agent' } : {};
		let context: ForwardContext | undefined;
		if (target.forwardClicks && counts(request, unlocked)) {
			let visitorId: string | undefined;
			if (!globalPrivacyControl(request)) {
				const existing = visitorCookie(request);
				visitorId = existing ?? newVisitorId();
				if (existing === null) {
					headers['set-cookie'] =
						`${visitorCookieName}=${visitorId}; Max-Age=${visitorCookieMaxAgeSeconds}; Path=/; Secure; HttpOnly; SameSite=Lax`;
					headers['cache-control'] = 'private, no-store';
				}
			}
			context = { ...address, location, ...(visitorId !== undefined ? { visitorId } : {}) };
		}
		const response = redirect(location, headers, unlocked ? 303 : 302);
		return settle(response, background, [...work, recordClick(request, target, context, unlocked)]);
	}

	// One try of the password. Tries count for each link and visitor IP; a fault of the limiter
	// or the key fails closed.
	async function unlock(
		request: Request,
		target: RedirectTarget,
		passwordHash: string,
		address: { hostname: string; slug: string },
		background: BackgroundWork | undefined,
		work: Promise<unknown>[]
	): Promise<Response> {
		const passwords = dependencies.linkPasswords;
		if (!passwords) {
			console.error(JSON.stringify({ event: 'link_password_unavailable' }));
			return settle(failed(request), background, work);
		}
		if (request.method !== 'POST')
			return settle(passwordForm(request, 401, null, dependencies), background, work);
		const password = await readPassword(request);
		if (password === null)
			return settle(passwordForm(request, 400, 'missing', dependencies), background, work);
		let allowed: boolean;
		try {
			const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
			allowed = (await passwords.attempts.limit({ key: `${target.linkId}:${ip}` })).success;
		} catch {
			console.error(JSON.stringify({ event: 'link_password_limit_failed' }));
			return settle(failed(request), background, work);
		}
		if (!allowed)
			return settle(
				passwordForm(request, 429, 'too-many', dependencies, { 'retry-after': '60' }),
				background,
				work
			);
		let check: Awaited<ReturnType<LinkPasswords['verify']>>;
		try {
			check = await passwords.keys.verify(password, passwordHash);
		} catch {
			check = 'other-key';
		}
		if (check === 'other-key') {
			console.error(JSON.stringify({ event: 'link_password_key_mismatch' }));
			return settle(failed(request), background, work);
		}
		if (check === 'mismatch')
			return settle(passwordForm(request, 401, 'wrong', dependencies), background, work);
		return redirectTo(request, target, address, background, work, true);
	}

	// The page that card bots get. The image is named only when this installation can serve it.
	function linkCard(
		request: Request,
		target: RedirectTarget,
		address: { hostname: string; slug: string }
	): Response {
		const shortUrl = `https://${address.hostname}/${address.slug}`;
		const image =
			target.previewImage !== null && dependencies.previewImages
				? `https://${address.hostname}${previewImagePath(address.slug, target.previewImage)}`
				: null;
		const page = linkCardPage({
			shortUrl,
			title: target.previewTitle ?? target.title ?? `${address.hostname}/${address.slug}`,
			description: target.previewDescription,
			image
		});
		return new Response(request.method === 'HEAD' ? null : page, { headers: linkCardHeaders });
	}

	function opensAt(target: RedirectTarget, time: number): boolean {
		return (
			(target.startsAt === null || time >= target.startsAt) &&
			(target.endsAt === null || time < target.endsAt)
		);
	}

	// The dates come before the card and the password: a link that has not opened or has ended
	// shows no card and asks for no password. A card bot gets the card also for a link with a
	// password, because the card holds only what the owner wrote for it.
	async function open(
		request: Request,
		target: RedirectTarget,
		address: { hostname: string; slug: string },
		background: BackgroundWork | undefined,
		work: Promise<unknown>[] = []
	): Promise<Response> {
		const time = now();
		if (target.startsAt !== null && time < target.startsAt)
			return settle(unavailable(request, 'not-open', dependencies), background, work);
		if (target.endsAt !== null && time >= target.endsAt)
			return settle(
				target.endedDestination !== null
					? redirect(target.endedDestination, {}, request.method === 'POST' ? 303 : 302)
					: unavailable(request, 'ended', dependencies),
				background,
				work
			);
		if (
			request.method !== 'POST' &&
			hasPreview(target) &&
			isCardFetcher(request.headers.get('user-agent'))
		)
			return settle(linkCard(request, target, address), background, work);
		if (target.passwordHash !== null)
			return unlock(request, target, target.passwordHash, address, background, work);
		if (request.method === 'POST')
			return settle(
				plain(request, 405, 'Method not allowed', { allow: 'GET, HEAD' }),
				background,
				work
			);
		return redirectTo(request, target, address, background, work);
	}

	const foreign = (target: RedirectTarget) =>
		dependencies.fixedTenantId !== undefined && target.tenantId !== dependencies.fixedTenantId;
	const notFound = (request: Request) => unavailable(request, 'not-found', dependencies);
	const blocked = (request: Request) => unavailable(request, 'blocked', dependencies);
	const failed = (request: Request) => unavailable(request, 'unavailable', dependencies);

	// The link at an address, from its snapshot or the database, or the response that ends the
	// request. work: the snapshot store to wait for.
	async function resolve(
		request: Request,
		hostname: string,
		slug: string
	): Promise<{ target: RedirectTarget; work: Promise<unknown>[] } | Response> {
		const key = new Request(`https://${hostname}/${slug}`);
		const cached = await readSnapshot(key);
		if (cached && now() < cached.validUntil)
			return foreign(cached) ? notFound(request) : { target: cached, work: [] };

		// The deadline counts from the query start, so a slow read cannot extend it.
		const validUntil = now() + snapshotLifetimeMs;
		let lookup: RedirectLookup | null;
		try {
			lookup = await findRedirectTarget(dependencies.routing, hostname, slug);
		} catch {
			console.error(JSON.stringify({ event: 'redirect_lookup_failed' }));
			return failed(request);
		}
		// Neither result is cached, so an unblock or a new link opens on the next request.
		if (!lookup) return notFound(request);
		if (lookup.kind === 'blocked') return blocked(request);
		if (now() >= validUntil) return failed(request);

		const { target } = lookup;
		if (foreign(target)) return notFound(request);
		return { target, work: [storeSnapshot(key, { ...target, validUntil })] };
	}

	// An image of the link, only while the link is open: a disabled or blocked link, or a link
	// outside its times, has no image. A replaced or removed image is deleted from the store, so
	// only the current one is found; the name is not checked against the snapshot, which can be
	// up to a minute old right after an upload.
	async function previewImage(
		request: Request,
		hostname: string,
		slug: string,
		file: string,
		background: BackgroundWork | undefined
	): Promise<Response> {
		if (request.method === 'POST')
			return plain(request, 405, 'Method not allowed', { allow: 'GET, HEAD' });
		const store = dependencies.previewImages;
		if (!store || !slugPattern.test(slug) || !previewImageFilePattern.test(file))
			return notFound(request);
		const resolved = await resolve(request, hostname, slug);
		if (resolved instanceof Response) return resolved;
		const { target, work } = resolved;
		if (!opensAt(target, now())) return settle(notFound(request), background, work);
		let object: Awaited<ReturnType<PreviewImageStore['get']>>;
		try {
			object = await store.get(previewImageKey(target.tenantId, target.linkId, file));
		} catch {
			console.error(JSON.stringify({ event: 'preview_image_read_failed' }));
			return settle(failed(request), background, work);
		}
		if (!object) return settle(notFound(request), background, work);
		if (request.method === 'HEAD') await object.body.cancel();
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
		// POST is only for the password form of a link.
		if (request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'POST')
			return plain(request, 405, 'Method not allowed', { allow: 'GET, HEAD' });
		const url = new URL(request.url);
		const hostname = url.hostname.replace(/\.$/, '');

		if (isReservedPath(url.pathname)) {
			if (request.method === 'POST')
				return plain(request, 405, 'Method not allowed', { allow: 'GET, HEAD' });
			let kind: Awaited<ReturnType<typeof activeDomainKind>>;
			try {
				kind = await activeDomainKind(dependencies.routing, hostname);
			} catch {
				console.error(JSON.stringify({ event: 'redirect_lookup_failed' }));
				return failed(request);
			}
			// A workspace domain serves only its links; its root is not a Flared page.
			if (kind !== 'platform') return notFound(request);
			return redirect(new URL(`${url.pathname}${url.search}`, dependencies.appOrigin).toString());
		}

		const image = /^\/([^/]+)\/preview\/([^/]+)$/.exec(url.pathname);
		if (image) return previewImage(request, hostname, image[1], image[2], background);

		const slug = url.pathname.slice(1);
		if (!slugPattern.test(slug)) return notFound(request);

		const resolved = await resolve(request, hostname, slug);
		if (resolved instanceof Response) return resolved;
		return open(request, resolved.target, { hostname, slug }, background, resolved.work);
	}

	return { fetch };
}
