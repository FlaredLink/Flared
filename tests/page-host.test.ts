// SPDX-License-Identifier: AGPL-3.0-only
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import {
	isPageViewEvent,
	parseAnalyticsEvent,
	type AnalyticsEvent,
	type ClickEvent,
	type PageViewEvent
} from '../packages/contracts/src/analytics';
import { purgeExpired } from '../packages/data/src/analytics';
import { deleteAnalyticsData } from '../packages/data/src/deletions';
import { handleRedirectMs } from '../packages/data/src/pages';
import { createTenant } from '../packages/data/src/tenancy';
import { createClickConsumer, type QueueMessage } from '../packages/server/src/analytics';
import { createApi } from '../packages/server/src/api';
import { createDeadLetterConsumer, requeueDeadLetter } from '../packages/server/src/operations';
import { createPageHandler, pageSnapshotLifetimeMs } from '../packages/server/src/page-host';
import { deleteTenantPageImages } from '../packages/server/src/page-images';
import { createRedirectHandler } from '../packages/server/src/redirect';
import { projectPolicy } from '../packages/server/src/tenancy';

const origin = 'https://app.example';
const pageHost = 'pages.example';
const identity = () => env.PAGEHOST_IDENTITY;
const routing = () => env.PAGEHOST_ROUTING;
const analytics = () => env.PAGEHOST_ANALYTICS;
const images = () => env.PAGE_IMAGES;
const shards = () => ({ 'analytics-1': analytics() });
let clock = Date.UTC(2026, 10, 1, 9);

const browser =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

function api() {
	return createApi({
		identity: identity(),
		routing: routing(),
		appOrigin: origin,
		// Test-only principal: a session for the user ID in a header the tests set.
		authenticate: async (request) => {
			const userId = request.headers.get('x-test-user');
			return userId
				? {
						kind: 'session',
						sessionId: 'session-test',
						userId,
						signedInAt: new Date(clock).toISOString()
					}
				: null;
		},
		now: () => clock,
		creationsPerMinute: 1000,
		analytics: shards(),
		pages: { host: pageHost },
		pageImages: images()
	});
}

let keyCounter = 0;
function call(user: string, method: string, path: string, body?: unknown, type?: string) {
	keyCounter += 1;
	const raw = body instanceof Uint8Array;
	return api().fetch(
		new Request(`${origin}${path}`, {
			method,
			headers: {
				origin,
				'x-test-user': user,
				'idempotency-key': `pagehost-${keyCounter}`,
				...(body === undefined ? {} : { 'content-type': type ?? 'application/json' })
			},
			body: body === undefined ? undefined : raw ? body : JSON.stringify(body)
		})
	);
}

async function json(response: Response) {
	const body = (await response.json()) as Record<string, any>;
	return body;
}

let slugCounter = 0;
async function createLink(user: string, fields: Record<string, unknown> = {}) {
	slugCounter += 1;
	const response = await call(user, 'POST', '/v1/links', {
		destination: 'https://example.com/landing',
		slug: `host-${slugCounter}`,
		...fields
	});
	const body = await json(response);
	expect(response.status, JSON.stringify(body)).toBe(201);
	return body.link as { id: string; shortUrl: string; slug: string };
}

let handleCounter = 0;
async function createPage(user: string, fields: Record<string, unknown> = {}) {
	handleCounter += 1;
	const response = await call(user, 'POST', '/v1/pages', {
		handle: `host-${handleCounter}`,
		title: 'My links',
		...fields
	});
	const body = await json(response);
	expect(response.status, JSON.stringify(body)).toBe(201);
	return body.page as { id: string; handle: string; url: string } & Record<string, any>;
}

// Each handler gets its own cache, so snapshots never leak between tests.
let cacheCounter = 0;
function pages(
	options: { views?: AnalyticsEvent[]; fixedTenantId?: string; store?: boolean } = {}
) {
	cacheCounter += 1;
	return createPageHandler({
		routing: routing(),
		host: pageHost,
		homeUrl: 'https://flared.example',
		cacheName: `page-test-${cacheCounter}`,
		views: options.views
			? {
					async send(event) {
						options.views?.push(event);
					}
				}
			: undefined,
		images: options.store === false ? undefined : images(),
		fixedTenantId: options.fixedTenantId,
		now: () => clock
	});
}

function visit(
	handler: { fetch(request: Request): Promise<Response> },
	url: string,
	headers: Record<string, string> = {},
	method = 'GET'
) {
	return handler.fetch(
		new Request(url, {
			method,
			redirect: 'manual',
			headers: { accept: 'text/html', 'user-agent': browser, ...headers }
		})
	);
}

async function addTenant(userId: string, tenantId: string, pageExtras: 0 | 1) {
	await identity()
		.prepare(
			'INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 0, 0)'
		)
		.bind(userId, '', `${userId}@example.com`)
		.run();
	await createTenant(identity(), {
		id: tenantId,
		name: 'Workspace',
		ownerUserId: userId,
		analyticsShardId: 'analytics-1',
		limits: {
			activeLinkLimit: 1000,
			monthlyClickLimit: 5000,
			retentionDays: 30,
			domainLimit: 5,
			pageLimit: 50,
			pageExtras
		},
		now: 1
	});
	await projectPolicy(identity(), { routing: routing(), analytics: shards() }, tenantId, 1);
}

async function addWorkspaceDomain(id: string, hostname: string, tenantId: string) {
	await routing().batch([
		routing()
			.prepare('INSERT INTO domain_namespaces (id, hostname, created_at) VALUES (?, ?, 0)')
			.bind(id, hostname),
		routing()
			.prepare(
				"INSERT INTO domains (id, tenant_id, state, is_default, created_at, updated_at) VALUES (?, ?, 'active', 0, 0, 0)"
			)
			.bind(id, tenantId)
	]);
}

beforeAll(async () => {
	await applyD1Migrations(identity(), env.IDENTITY_MIGRATIONS, 'flared_core_migrations');
	await applyD1Migrations(routing(), env.ROUTING_MIGRATIONS, 'flared_core_migrations');
	await applyD1Migrations(analytics(), env.ANALYTICS_MIGRATIONS, 'flared_core_migrations');
	await identity()
		.prepare("INSERT INTO installation (id, mode, created_at) VALUES (1, 'multi', 0)")
		.run();
	await routing().batch([
		routing().prepare(
			"INSERT INTO domain_namespaces (id, hostname, created_at) VALUES ('dom-short', 'short.example', 0)"
		),
		routing().prepare(
			"INSERT INTO domains (id, tenant_id, state, is_default, created_at, updated_at) VALUES ('dom-short', NULL, 'active', 1, 0, 0)"
		)
	]);
	await addTenant('user-plus', 'tenant-plus', 1);
	await addTenant('user-free', 'tenant-free', 0);
	await addTenant('user-other', 'tenant-other', 1);
	await addWorkspaceDomain('dom-plus', 'links.plus.example', 'tenant-plus');
	await addWorkspaceDomain('dom-plus-2', 'more.plus.example', 'tenant-plus');
	await addWorkspaceDomain('dom-other', 'other.example', 'tenant-other');
});

describe('the page', () => {
	it('shows the profile and visible blocks with a strict policy and no cookie', async () => {
		const link = await createLink('user-plus');
		const off = await createLink('user-plus');
		await call('user-plus', 'PATCH', `/v1/links/${off.id}`, { enabled: false });
		const page = await createPage('user-plus', {
			bio: 'Line one\nLine two',
			blocks: [
				{ kind: 'header', label: 'Projects' },
				{ kind: 'button', linkId: link.id, label: 'My site' },
				{ kind: 'button', linkId: off.id, label: 'Hidden button' },
				{
					kind: 'social',
					links: [
						{ network: 'github', address: 'https://github.com/flared' },
						{ network: 'email', address: 'me@example.com' }
					]
				}
			]
		});
		expect(page.url).toBe(`https://${page.handle}.${pageHost}`);
		const response = await visit(pages(), `${page.url}/`);
		expect(response.status).toBe(200);
		const html = await response.text();
		expect(html).toContain('<h1>My links</h1>');
		expect(html).toContain('<p class="bio">Line one\nLine two</p>');
		expect(html).toContain('<h2>Projects</h2>');
		expect(html).toContain(`<a class="button" href="${link.shortUrl}">My site</a>`);
		expect(html).not.toContain('Hidden button');
		expect(html).toContain('href="https://github.com/flared" rel="me">GitHub</a>');
		expect(html).toContain('href="mailto:me@example.com" rel="me">Email</a>');
		expect(html).toContain(`<link rel="canonical" href="${page.url}/">`);
		expect(html).not.toContain('<script');
		expect(html).not.toContain('Made with Flared');
		const policy = response.headers.get('content-security-policy') ?? '';
		expect(policy).toContain("default-src 'none'");
		expect(policy).not.toContain('script-src');
		expect(policy).not.toContain('frame-src');
		expect(response.headers.get('x-content-type-options')).toBe('nosniff');
		expect(response.headers.get('set-cookie')).toBeNull();
	});

	it('escapes every member text', async () => {
		const page = await createPage('user-plus', {
			title: '<script>alert(1)</script>',
			bio: '"><img src=x onerror=alert(1)>',
			blocks: [{ kind: 'header', label: '</h2><script>x</script>' }]
		});
		const html = await (await visit(pages(), `${page.url}/`)).text();
		expect(html).not.toContain('<script>');
		expect(html).not.toContain('<img src=x');
		expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
		expect(html).toContain('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
	});

	it('shows a scheduled block from its start up to its end', async () => {
		const start = clock + 3600000;
		const end = clock + 7200000;
		const page = await createPage('user-plus', {
			blocks: [
				{
					kind: 'header',
					label: 'Sale',
					startsAt: new Date(start).toISOString(),
					endsAt: new Date(end).toISOString()
				}
			]
		});
		const saved = clock;
		const handler = pages();
		try {
			clock = start - 1;
			expect(await (await visit(handler, `${page.url}/`)).text()).not.toContain('Sale');
			clock = start;
			expect(await (await visit(handler, `${page.url}/`)).text()).toContain('<h2>Sale</h2>');
			clock = end - 1;
			expect(await (await visit(handler, `${page.url}/`)).text()).toContain('<h2>Sale</h2>');
			clock = end;
			expect(await (await visit(handler, `${page.url}/`)).text()).not.toContain('Sale');
		} finally {
			clock = saved;
		}
	});

	it('names only the players that the page shows in frame-src', async () => {
		const page = await createPage('user-plus', {
			blocks: [
				{ kind: 'embed', provider: 'youtube', address: 'https://youtu.be/dQw4w9WgXcQ' },
				{ kind: 'signup', label: 'News', buttonLabel: 'Join' }
			]
		});
		const response = await visit(pages(), `${page.url}/`);
		const html = await response.text();
		expect(html).toContain('src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"');
		expect(html).toContain('sandbox="');
		expect(html).not.toContain('<form');
		expect(response.headers.get('content-security-policy')).toContain(
			'frame-src https://www.youtube-nocookie.com;'
		);
	});

	it('shows the badge on a plan without page extras', async () => {
		const page = await createPage('user-free');
		const html = await (await visit(pages(), `${page.url}/`)).text();
		expect(html).toContain(
			'<footer><a href="https://flared.example">Made with Flared</a></footer>'
		);
	});

	it('answers 404 for an unknown handle, another path, a label that is no handle, and the host', async () => {
		const page = await createPage('user-plus');
		const handler = pages();
		expect((await visit(handler, `https://nobody-here.${pageHost}/`)).status).toBe(404);
		expect((await visit(handler, `${page.url}/about`)).status).toBe(404);
		expect((await visit(handler, `https://a--b.${pageHost}/`)).status).toBe(404);
		expect((await visit(handler, `https://${pageHost}/`)).status).toBe(404);
		const post = await visit(handler, `${page.url}/`, {}, 'POST');
		expect(post.status).toBe(405);
	});

	it('hides a disabled page and shows 410 for a blocked page or a suspended workspace', async () => {
		const disabled = await createPage('user-plus');
		await call('user-plus', 'PATCH', `/v1/pages/${disabled.id}`, { enabled: false });
		expect((await visit(pages(), `${disabled.url}/`)).status).toBe(404);

		const blocked = await createPage('user-plus');
		await routing()
			.prepare("UPDATE pages SET blocked_at = 1, blocked_reason = 'phishing' WHERE id = ?")
			.bind(blocked.id)
			.run();
		const response = await visit(pages(), `${blocked.url}/`);
		expect(response.status).toBe(410);
		expect(await response.text()).toContain('This page was blocked');

		const suspended = await createPage('user-other');
		await routing()
			.prepare("UPDATE tenant_policy SET suspended_at = 1 WHERE tenant_id = 'tenant-other'")
			.run();
		try {
			expect((await visit(pages(), `${suspended.url}/`)).status).toBe(410);
		} finally {
			await routing()
				.prepare("UPDATE tenant_policy SET suspended_at = NULL WHERE tenant_id = 'tenant-other'")
				.run();
		}
	});

	it('keeps a snapshot for 60 seconds', async () => {
		const page = await createPage('user-plus');
		const handler = pages();
		const saved = clock;
		try {
			expect(await (await visit(handler, `${page.url}/`)).text()).toContain('<h1>My links</h1>');
			await call('user-plus', 'PATCH', `/v1/pages/${page.id}`, { title: 'Renamed' });
			clock = saved + pageSnapshotLifetimeMs - 1;
			expect(await (await visit(handler, `${page.url}/`)).text()).toContain('<h1>My links</h1>');
			clock = saved + pageSnapshotLifetimeMs;
			expect(await (await visit(handler, `${page.url}/`)).text()).toContain('<h1>Renamed</h1>');
		} finally {
			clock = saved;
		}
	});

	it('sends an old handle to the new one for 90 days, then shows not found', async () => {
		const page = await createPage('user-plus');
		const renamed = `${page.handle}-new`;
		const change = await call('user-plus', 'PATCH', `/v1/pages/${page.id}`, { handle: renamed });
		expect(change.status).toBe(200);
		const moved = await visit(pages(), `${page.url}/`);
		expect(moved.status).toBe(302);
		expect(moved.headers.get('location')).toBe(`https://${renamed}.${pageHost}/`);
		expect((await visit(pages(), `https://${renamed}.${pageHost}/`)).status).toBe(200);
		const saved = clock;
		try {
			clock = saved + handleRedirectMs;
			expect((await visit(pages(), `${page.url}/`)).status).toBe(404);
		} finally {
			clock = saved;
		}
	});

	it('shows nothing at the handle of a deleted page', async () => {
		const page = await createPage('user-plus');
		expect((await call('user-plus', 'DELETE', `/v1/pages/${page.id}`)).status).toBe(204);
		expect((await visit(pages(), `${page.url}/`)).status).toBe(404);
	});

	it('shows only the fixed tenant page on a single-workspace installation', async () => {
		const page = await createPage('user-other');
		const handler = pages({ fixedTenantId: 'tenant-plus' });
		expect((await visit(handler, `${page.url}/`)).status).toBe(404);
	});
});

describe('the page on a workspace domain', () => {
	function redirects(views?: AnalyticsEvent[]) {
		cacheCounter += 1;
		return createRedirectHandler({
			routing: routing(),
			appOrigin: origin,
			cacheName: `page-redirect-test-${cacheCounter}`,
			now: () => clock,
			pages: pages({ views })
		});
	}

	it('shows the page at the root and keeps redirecting slugs', async () => {
		const link = await createLink('user-plus', { domainId: 'dom-plus' });
		const page = await createPage('user-plus', {
			domainId: 'dom-plus',
			blocks: [{ kind: 'button', linkId: link.id, label: 'Shop' }]
		});
		expect(page.domainUrl).toBe('https://links.plus.example');
		const handler = redirects();
		const root = await visit(handler, 'https://links.plus.example/');
		expect(root.status).toBe(200);
		const html = await root.text();
		expect(html).toContain('<a class="button" href="https://links.plus.example/');
		expect(html).toContain('<link rel="canonical" href="https://links.plus.example/">');
		const slug = await visit(handler, `https://links.plus.example/${link.slug}`);
		expect(slug.status).toBe(302);
		expect(slug.headers.get('location')).toBe('https://example.com/landing');
		// The handle address names the domain as the page's address.
		const byHandle = await (await visit(pages(), `${page.url}/`)).text();
		expect(byHandle).toContain('<link rel="canonical" href="https://links.plus.example/">');
	});

	it('answers 404 at the root of a domain without a page, and of a platform domain it does not redirect', async () => {
		const handler = redirects();
		expect((await visit(handler, 'https://more.plus.example/')).status).toBe(404);
		const platform = await visit(handler, 'https://short.example/');
		expect(platform.status).toBe(302);
		expect(platform.headers.get('location')).toBe(`${origin}/`);
		expect(
			(await visit(handler, 'https://short.example/_image/aaaaaaaaaaaaaaaaaaaaaa.png')).status
		).toBe(404);
	});

	it('stops showing the page when the domain is turned off', async () => {
		await addWorkspaceDomain('dom-plus-3', 'gone.plus.example', 'tenant-plus');
		await createPage('user-plus', { domainId: 'dom-plus-3' });
		expect((await visit(redirects(), 'https://gone.plus.example/')).status).toBe(200);
		await routing().prepare("UPDATE domains SET state = 'disabled' WHERE id = 'dom-plus-3'").run();
		expect((await visit(redirects(), 'https://gone.plus.example/')).status).toBe(404);
	});

	it('counts a page view on the domain root', async () => {
		const page = await createPage('user-other', { domainId: 'dom-other' });
		const views: AnalyticsEvent[] = [];
		await visit(redirects(views), 'https://other.example/');
		expect(views).toHaveLength(1);
		expect(views[0]).toMatchObject({
			type: 'page_view',
			pageId: page.id,
			tenantId: 'tenant-other'
		});
	});
});

describe('page images', () => {
	it('serves the avatar on the page host and deletes a replaced image', async () => {
		const page = await createPage('user-plus');
		const first = await json(
			await call('user-plus', 'PUT', `/v1/pages/${page.id}/avatar-image`, png, 'image/png')
		);
		const avatar = first.page.avatarImage as string;
		expect(avatar).toMatch(new RegExp(`^${page.url}/_image/[A-Za-z0-9_-]{22}\\.png$`));
		const handler = pages();
		const html = await (await visit(handler, `${page.url}/`)).text();
		expect(html).toContain(`<img class="avatar" src="${avatar}"`);
		expect(html).toContain(`<meta property="og:image" content="${avatar}">`);
		const image = await visit(handler, avatar);
		expect(image.status).toBe(200);
		expect(image.headers.get('content-type')).toBe('image/png');
		expect(new Uint8Array(await image.arrayBuffer())).toEqual(png);

		const second = await json(
			await call('user-plus', 'PUT', `/v1/pages/${page.id}/avatar-image`, png, 'image/png')
		);
		expect(second.page.avatarImage).not.toBe(avatar);
		expect((await visit(handler, avatar)).status).toBe(404);
		expect((await visit(handler, second.page.avatarImage)).status).toBe(200);
	});

	it('does not serve one page image on another page', async () => {
		const owner = await createPage('user-plus');
		const other = await createPage('user-plus');
		const body = await json(
			await call('user-plus', 'PUT', `/v1/pages/${owner.id}/background-image`, png, 'image/png')
		);
		const file = (body.page.backgroundImage as string).split('/_image/')[1];
		expect((await visit(pages(), `${other.url}/_image/${file}`)).status).toBe(404);
		const html = await (await visit(pages(), `${owner.url}/`)).text();
		expect(html).toContain(`url("${owner.url}/_image/${file}")`);
	});

	it('refuses a file that is not an image and removes the image', async () => {
		const page = await createPage('user-plus');
		const text = new TextEncoder().encode('not an image');
		const refused = await call(
			'user-plus',
			'PUT',
			`/v1/pages/${page.id}/avatar-image`,
			text,
			'image/png'
		);
		expect(refused.status).toBe(415);
		await call('user-plus', 'PUT', `/v1/pages/${page.id}/avatar-image`, png, 'image/png');
		const removed = await json(
			await call('user-plus', 'DELETE', `/v1/pages/${page.id}/avatar-image`)
		);
		expect(removed.page.avatarImage).toBeNull();
		const { objects } = await images().list({ prefix: `tenant-plus/${page.id}/` });
		expect(objects).toHaveLength(0);
	});

	it('deletes the images with the page and with the workspace', async () => {
		const page = await createPage('user-free');
		await call('user-free', 'PUT', `/v1/pages/${page.id}/avatar-image`, png, 'image/png');
		await call('user-free', 'DELETE', `/v1/pages/${page.id}`);
		expect((await images().list({ prefix: `tenant-free/${page.id}/` })).objects).toHaveLength(0);

		const kept = await createPage('user-free');
		await call('user-free', 'PUT', `/v1/pages/${kept.id}/avatar-image`, png, 'image/png');
		while ((await deleteTenantPageImages(images(), 'tenant-free', 1)) > 0);
		expect((await images().list({ prefix: 'tenant-free/' })).objects).toHaveLength(0);
	});
});

describe('page views', () => {
	function queue(events: readonly AnalyticsEvent[]) {
		const acked: boolean[] = [];
		const messages: QueueMessage[] = events.map((event, index) => ({
			body: JSON.parse(JSON.stringify(event)),
			ack: () => void (acked[index] = true),
			retry: () => void (acked[index] = false)
		}));
		return { messages, acked };
	}

	it('counts a GET from a person, never HEAD, a bot, or a prefetch', async () => {
		const page = await createPage('user-plus');
		const views: AnalyticsEvent[] = [];
		const handler = pages({ views });
		await visit(handler, `${page.url}/`, { referer: 'https://news.example/post' });
		await visit(handler, `${page.url}/`, {}, 'HEAD');
		await visit(handler, `${page.url}/`, { 'user-agent': 'Slackbot-LinkExpanding 1.0' });
		await visit(handler, `${page.url}/`, { 'sec-purpose': 'prefetch' });
		expect(views).toHaveLength(1);
		const [view] = views;
		expect(isPageViewEvent(view)).toBe(true);
		expect(view).toMatchObject({
			type: 'page_view',
			pageId: page.id,
			tenantId: 'tenant-plus',
			analyticsShardId: 'analytics-1',
			referrerHostname: 'news.example',
			browser: 'safari',
			os: 'macos'
		});
		expect(parseAnalyticsEvent(JSON.parse(JSON.stringify(view)))).toEqual(view);
	});

	it('records views apart from clicks, once per event, and reads them with button clicks', async () => {
		const link = await createLink('user-plus');
		const page = await createPage('user-plus', {
			blocks: [{ kind: 'button', linkId: link.id, label: 'Shop' }]
		});
		const views: AnalyticsEvent[] = [];
		const handler = pages({ views });
		await visit(handler, `${page.url}/`);
		await visit(handler, `${page.url}/`, {
			'user-agent':
				'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1'
		});
		const view = views[0] as PageViewEvent;
		const click: ClickEvent = {
			schemaVersion: 1,
			eventId: crypto.randomUUID(),
			tenantId: 'tenant-plus',
			analyticsShardId: 'analytics-1',
			linkId: link.id,
			kind: 'production',
			occurredAt: clock,
			country: 'JP',
			deviceCategory: 'desktop',
			referrerHostname: new URL(page.url).hostname,
			browser: 'safari',
			os: 'macos'
		};
		const before = await analytics()
			.prepare(
				"SELECT COALESCE(SUM(clicks), 0) AS clicks FROM monthly_usage WHERE tenant_id = 'tenant-plus'"
			)
			.first<{ clicks: number }>();
		const consume = createClickConsumer({ shards: shards(), now: () => clock });
		const batch = queue([...views, view, click]);
		expect(await consume(batch)).toEqual(['admitted', 'admitted', 'duplicate', 'admitted']);
		expect(batch.acked).toEqual([true, true, true, true]);
		const after = await analytics()
			.prepare(
				"SELECT COALESCE(SUM(clicks), 0) AS clicks FROM monthly_usage WHERE tenant_id = 'tenant-plus'"
			)
			.first<{ clicks: number }>();
		expect((after?.clicks ?? 0) - (before?.clicks ?? 0)).toBe(1);

		const response = await call('user-plus', 'GET', `/v1/pages/${page.id}/analytics`);
		const body = await json(response);
		expect(response.status, JSON.stringify(body)).toBe(200);
		const result = body.analytics;
		expect(result.views).toBe(2);
		expect(result.days.at(-1)).toEqual({ day: '2026-11-01', views: 2 });
		expect(result.devices).toEqual(
			expect.arrayContaining([
				{ value: 'desktop', views: 1 },
				{ value: 'mobile', views: 1 }
			])
		);
		expect(result.buttons).toEqual([{ linkId: link.id, label: 'Shop', clicks: 1 }]);
	});

	it('refuses the analytics of another workspace page', async () => {
		const page = await createPage('user-other');
		const response = await call('user-plus', 'GET', `/v1/pages/${page.id}/analytics`);
		expect(response.status).toBe(404);
	});

	it('purges views past retention and deletes them with the workspace', async () => {
		await analytics().batch([
			analytics().prepare(
				"INSERT INTO page_daily_totals (tenant_id, page_id, day, views) VALUES ('tenant-free', 'page-old', '2026-01-01', 3)"
			),
			analytics().prepare(
				"INSERT INTO page_daily_dimensions (tenant_id, page_id, day, dimension, value, views) VALUES ('tenant-free', 'page-old', '2026-01-01', 'country', 'JP', 3)"
			)
		]);
		while ((await purgeExpired(analytics(), clock, 1000)).deleted > 0);
		const old = await analytics()
			.prepare(
				"SELECT (SELECT COUNT(*) FROM page_daily_totals WHERE page_id = 'page-old') + (SELECT COUNT(*) FROM page_daily_dimensions WHERE page_id = 'page-old') AS rows"
			)
			.first<{ rows: number }>();
		expect(old?.rows).toBe(0);

		await analytics()
			.prepare(
				"INSERT INTO page_daily_totals (tenant_id, page_id, day, views) VALUES ('tenant-free', 'page-new', '2026-11-01', 1)"
			)
			.run();
		while ((await deleteAnalyticsData(analytics(), 'tenant-free', 1000)) > 0);
		const left = await analytics()
			.prepare("SELECT COUNT(*) AS rows FROM page_daily_totals WHERE tenant_id = 'tenant-free'")
			.first<{ rows: number }>();
		expect(left?.rows).toBe(0);
	});

	it('keeps a dead page view and sends it back as a page view', async () => {
		const page = await createPage('user-plus');
		const views: AnalyticsEvent[] = [];
		await visit(pages({ views }), `${page.url}/`);
		const view = views[0] as PageViewEvent;
		await createDeadLetterConsumer({ identity: identity(), now: () => clock })({
			messages: [{ ...queue([view]).messages[0], id: 'message-1' }]
		});
		const sent: AnalyticsEvent[] = [];
		expect(
			await requeueDeadLetter(
				identity(),
				{ send: async (event) => void sent.push(event) },
				`event:${view.eventId}`,
				clock
			)
		).toBe('requeued');
		expect(sent).toEqual([view]);
	});
});
