// SPDX-License-Identifier: AGPL-3.0-only
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { isPageViewEvent, type ClickEvent } from '../packages/contracts/src/analytics';
import {
	LinkInputError,
	maxPreviewImageBytes,
	parseCreateLink,
	parseUpdateLink
} from '../packages/contracts/src/links';
import { createLinkRecord, replacePreviewImage, updateLink } from '../packages/data/src/links';
import { listUnprojectedLimits } from '../packages/data/src/routing-policy';
import { linkJson } from '../packages/data/src/webhooks';
import { createTenant } from '../packages/data/src/tenancy';
import { createApi } from '../packages/server/src/api';
import { createLinkPasswords } from '../packages/server/src/link-passwords';
import { isCardFetcher } from '../packages/server/src/link-previews';
import { deleteTenantPreviewImages, previewImageKey } from '../packages/server/src/preview-images';
import { createRedirectHandler, type AttemptLimiter } from '../packages/server/src/redirect';
import { projectPolicy, retryProjections } from '../packages/server/src/tenancy';

const origin = 'https://app.example';
const identity = () => env.PREVIEW_IDENTITY;
const routing = () => env.PREVIEW_ROUTING;
const images = () => env.PREVIEW_IMAGES;
let clock = Date.UTC(2026, 10, 1, 9);
const passwords = createLinkPasswords('test-only-link-password-secret-of-32-characters');

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

function api(options: { store?: boolean } = {}) {
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
		linkPasswords: passwords,
		previewImages: options.store === false ? undefined : images()
	});
}

let keyCounter = 0;
function call(
	user: string,
	method: string,
	path: string,
	body?: unknown,
	app = api(),
	headers: Record<string, string> = {}
) {
	keyCounter += 1;
	const json = body !== undefined && !(body instanceof Uint8Array);
	return app.fetch(
		new Request(`${origin}${path}`, {
			method,
			headers: {
				origin,
				'x-test-user': user,
				'idempotency-key': `preview-${keyCounter}`,
				...(json ? { 'content-type': 'application/json' } : {}),
				...headers
			},
			body: body === undefined ? undefined : json ? JSON.stringify(body) : (body as Uint8Array)
		})
	);
}

function upload(user: string, linkId: string, bytes: Uint8Array, type = 'image/png', app = api()) {
	return call(user, 'PUT', `/v1/links/${linkId}/preview-image`, bytes, app, {
		'content-type': type
	});
}

async function json(response: Response) {
	return (await response.json()) as Record<string, any>;
}

let slugCounter = 0;
async function createLink(user: string, fields: Record<string, unknown>) {
	slugCounter += 1;
	const response = await call(user, 'POST', '/v1/links', {
		destination: 'https://example.com/landing',
		slug: `preview-${slugCounter}`,
		...fields
	});
	const body = await json(response);
	expect(response.status, JSON.stringify(body)).toBe(201);
	return body.link as { id: string; slug: string } & Record<string, unknown>;
}

async function stored(tenantId: string, linkId: string): Promise<string[]> {
	const { objects } = await images().list({ prefix: `${tenantId}/${linkId}/` });
	return objects.map((object) => object.key);
}

async function addTenant(userId: string, tenantId: string, linkPreviews: 0 | 1) {
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
			domainLimit: 1,
			linkAccess: 1,
			linkPreviews
		},
		now: 1
	});
	await projectPolicy(
		identity(),
		{ routing: routing(), analytics: { 'analytics-1': env.PREVIEW_ANALYTICS } },
		tenantId,
		1
	);
}

beforeAll(async () => {
	await applyD1Migrations(identity(), env.IDENTITY_MIGRATIONS, 'flared_core_migrations');
	await applyD1Migrations(routing(), env.ROUTING_MIGRATIONS, 'flared_core_migrations');
	await applyD1Migrations(
		env.PREVIEW_ANALYTICS,
		env.ANALYTICS_MIGRATIONS,
		'flared_core_migrations'
	);
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
});

describe('preview input', () => {
	it('trims the texts, treats empty as none, and refuses long or control text', () => {
		const base = { destination: 'https://example.com' };
		const field = (fields: Record<string, unknown>) => {
			try {
				parseCreateLink({ ...base, ...fields });
				return null;
			} catch (error) {
				return error instanceof LinkInputError ? error.field : 'other';
			}
		};
		expect(parseCreateLink({ ...base, previewTitle: '  Spring sale  ' })).toMatchObject({
			previewTitle: 'Spring sale',
			previewDescription: null
		});
		expect(parseCreateLink({ ...base, previewDescription: '   ' }).previewDescription).toBeNull();
		expect(field({ previewTitle: 'a'.repeat(201) })).toBe('previewTitle');
		expect(field({ previewTitle: 'a'.repeat(200) })).toBeNull();
		expect(field({ previewDescription: 'a'.repeat(501) })).toBe('previewDescription');
		expect(field({ previewDescription: 'one\ntwo' })).toBe('previewDescription');
		expect(field({ previewTitle: 7 })).toBe('previewTitle');
		expect(field({ previewImage: 'https://example.com/a.png' })).toBe('previewImage');
		expect(parseUpdateLink({ previewTitle: null })).toEqual({ previewTitle: null });
	});
});

describe('social previews in the API', () => {
	it('stores the texts on Plus and returns them on every read', async () => {
		const link = await createLink('user-plus', {
			previewTitle: 'Spring sale',
			previewDescription: 'Half price until Sunday.'
		});
		expect(link).toMatchObject({
			previewTitle: 'Spring sale',
			previewDescription: 'Half price until Sunday.',
			previewImage: null
		});
		const read = await json(await call('user-plus', 'GET', `/v1/links/${link.id}`));
		expect(read.link.previewTitle).toBe('Spring sale');
		const changed = await call('user-plus', 'PATCH', `/v1/links/${link.id}`, {
			previewTitle: 'Summer sale',
			previewDescription: null
		});
		expect((await json(changed)).link).toMatchObject({
			previewTitle: 'Summer sale',
			previewDescription: null
		});
	});

	it('refuses new texts and images without the plan, and allows clearing them', async () => {
		const create = await call('user-free', 'POST', '/v1/links', {
			destination: 'https://example.com',
			previewTitle: 'Card'
		});
		expect(create.status).toBe(403);
		expect((await json(create)).error.code).toBe('LINK_PREVIEW_REQUIRES_PLAN');
		const link = await createLink('user-free', {});
		const patch = await call('user-free', 'PATCH', `/v1/links/${link.id}`, {
			previewDescription: 'Card'
		});
		expect((await json(patch)).error.code).toBe('LINK_PREVIEW_REQUIRES_PLAN');
		const image = await upload('user-free', link.id, png);
		expect(image.status).toBe(403);
		expect((await json(image)).error.code).toBe('LINK_PREVIEW_REQUIRES_PLAN');
		expect(await stored('tenant-free', link.id)).toEqual([]);

		// A downgraded workspace keeps what it set: the same value again is no change, and it can
		// clear the texts and remove the image.
		await routing()
			.prepare(
				"UPDATE links SET preview_title = 'Kept', preview_image = '3q2-7wEAAAAAAAAAAAAAAA.png' WHERE id = ?"
			)
			.bind(link.id)
			.run();
		await images().put(previewImageKey('tenant-free', link.id, '3q2-7wEAAAAAAAAAAAAAAA.png'), png);
		const same = await call('user-free', 'PATCH', `/v1/links/${link.id}`, {
			previewTitle: 'Kept',
			title: 'Renamed'
		});
		expect(same.status).toBe(200);
		const cleared = await call('user-free', 'PATCH', `/v1/links/${link.id}`, {
			previewTitle: null
		});
		expect((await json(cleared)).link.previewTitle).toBeNull();
		const removed = await call('user-free', 'DELETE', `/v1/links/${link.id}/preview-image`);
		expect(removed.status).toBe(200);
		expect((await json(removed)).link.previewImage).toBeNull();
		expect(await stored('tenant-free', link.id)).toEqual([]);
	});

	it('refuses a plan-gated import item', async () => {
		const response = await call('user-free', 'POST', '/v1/links/import', {
			dryRun: true,
			items: [
				{ destination: 'https://example.com/one' },
				{ destination: 'https://example.com/two', previewTitle: 'Card' }
			]
		});
		const result = await json(response);
		expect(result.results.map((item: { status: string }) => item.status)).toEqual([
			'ready',
			'failed'
		]);
		expect(result.results[1].error.code).toBe('LINK_PREVIEW_REQUIRES_PLAN');
		const run = await call('user-plus', 'POST', '/v1/links/import', {
			dryRun: false,
			items: [{ destination: 'https://example.com/three', previewTitle: 'Imported card' }]
		});
		expect((await json(run)).results[0].link.previewTitle).toBe('Imported card');
	});

	it('stores an image, replaces it, and deletes the old object', async () => {
		const link = await createLink('user-plus', {});
		const first = await upload('user-plus', link.id, png);
		expect(first.status).toBe(200);
		const firstUrl: string = (await json(first)).link.previewImage;
		expect(firstUrl).toMatch(
			new RegExp(`^https://short\\.example/${link.slug}/preview/[A-Za-z0-9_-]{22}\\.png$`)
		);
		expect(await stored('tenant-plus', link.id)).toHaveLength(1);
		const second = await upload('user-plus', link.id, webp, 'image/webp');
		const secondUrl: string = (await json(second)).link.previewImage;
		expect(secondUrl).toMatch(/\.webp$/);
		const keys = await stored('tenant-plus', link.id);
		expect(keys).toEqual([previewImageKey('tenant-plus', link.id, secondUrl.split('/').pop()!)]);
		const object = await images().get(keys[0]);
		expect(object?.httpMetadata?.contentType).toBe('image/webp');
		const jpg = await upload('user-plus', link.id, jpeg, 'image/jpeg');
		expect((await json(jpg)).link.previewImage).toMatch(/\.jpg$/);
	});

	it('checks the bytes, the media type, and the size', async () => {
		const link = await createLink('user-plus', {});
		const html = new TextEncoder().encode('<html><script>alert(1)</script></html>');
		const fake = await upload('user-plus', link.id, html);
		expect(fake.status).toBe(415);
		const svg = await upload('user-plus', link.id, png, 'image/svg+xml');
		expect(svg.status).toBe(415);
		const large = new Uint8Array(maxPreviewImageBytes + 1);
		large.set(png);
		const tooLarge = await upload('user-plus', link.id, large);
		expect(tooLarge.status).toBe(413);
		const empty = await upload('user-plus', link.id, new Uint8Array());
		expect(empty.status).toBe(422);
		// Without a Content-Length, the body is still read only up to the limit.
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(png);
				controller.enqueue(new Uint8Array(maxPreviewImageBytes));
				controller.close();
			}
		});
		const streamed = await api().fetch(
			new Request(`${origin}/v1/links/${link.id}/preview-image`, {
				method: 'PUT',
				headers: { origin, 'x-test-user': 'user-plus', 'content-type': 'image/png' },
				body: stream,
				// @ts-expect-error duplex is required for a stream body and missing from the types
				duplex: 'half'
			})
		);
		expect(streamed.status).toBe(413);
		expect(await stored('tenant-plus', link.id)).toEqual([]);
	});

	it('answers 503 for an upload without a store, and 404 for another tenant', async () => {
		const link = await createLink('user-plus', {});
		const none = await upload('user-plus', link.id, png, 'image/png', api({ store: false }));
		expect(none.status).toBe(503);
		const other = await upload('user-free', link.id, png);
		expect(other.status).toBe(404);
		expect(await stored('tenant-plus', link.id)).toEqual([]);
	});

	it('refuses an image on a blocked link and keeps the stored one', async () => {
		const link = await createLink('user-plus', {});
		await upload('user-plus', link.id, png);
		await routing()
			.prepare("UPDATE links SET blocked_at = 1, blocked_reason = 'spam' WHERE id = ?")
			.bind(link.id)
			.run();
		expect((await upload('user-plus', link.id, webp, 'image/webp')).status).toBe(409);
		expect((await call('user-plus', 'DELETE', `/v1/links/${link.id}/preview-image`)).status).toBe(
			409
		);
		expect(await stored('tenant-plus', link.id)).toHaveLength(1);
	});
});

describe('preview guards in the database', () => {
	it('swaps the image name only from the name it read, and only with the plan', async () => {
		const link = await createLink('user-plus', {});
		const swap = (from: string | null, to: string | null, tenantId = 'tenant-plus') =>
			replacePreviewImage(routing(), { tenantId, linkId: link.id, from, to, now: clock });
		expect(await swap(null, 'AAAAAAAAAAAAAAAAAAAAAA.png')).toBe(true);
		expect(await swap(null, 'BBBBBBBBBBBBBBBBBBBBBB.png')).toBe(false);
		expect(await swap('AAAAAAAAAAAAAAAAAAAAAA.png', 'BBBBBBBBBBBBBBBBBBBBBB.png')).toBe(true);
		const free = await createLink('user-free', {});
		expect(
			await replacePreviewImage(routing(), {
				tenantId: 'tenant-free',
				linkId: free.id,
				from: null,
				to: 'AAAAAAAAAAAAAAAAAAAAAA.png',
				now: clock
			})
		).toBe(false);
	});

	it('refuses preview texts in the create batch and the update without the plan', async () => {
		const create = await createLinkRecord(routing(), {
			tenantId: 'tenant-free',
			key: 'preview-race-1',
			requestHash: 'hash',
			linkId: 'preview-race-link',
			domainId: 'dom-short',
			slug: 'preview-race-guard',
			generatedSlug: false,
			destination: 'https://example.com/race',
			title: null,
			iosDestination: null,
			androidDestination: null,
			startsAt: null,
			endsAt: null,
			endedDestination: null,
			passwordHash: null,
			previewTitle: 'Card',
			previewDescription: null,
			now: clock,
			expiresAt: clock + 60_000,
			bodies: { created: '{}', slugTaken: '{}', limitReached: '{}' },
			event: { id: 'evt-preview-race', payload: '{}' }
		});
		expect(create.outcome).toBe('unavailable');
		const link = await createLink('user-free', {});
		const update = await updateLink(routing(), 'tenant-free', link.id, {
			previewDescription: 'Card',
			now: clock,
			eventId: 'evt-preview-race-2'
		});
		expect(update.updated).toBe(false);
	});

	it('heals a routing row projected before link previews', async () => {
		await routing()
			.prepare("UPDATE tenant_policy SET link_previews = NULL WHERE tenant_id = 'tenant-plus'")
			.run();
		expect(await listUnprojectedLimits(routing(), 10)).toContain('tenant-plus');
		await retryProjections(
			identity(),
			{ routing: routing(), analytics: { 'analytics-1': env.PREVIEW_ANALYTICS } },
			clock,
			10
		);
		const healed = await routing()
			.prepare("SELECT link_previews FROM tenant_policy WHERE tenant_id = 'tenant-plus'")
			.first<{ link_previews: number | null }>();
		expect(healed?.link_previews).toBe(1);
	});

	it('gives webhook payloads the same preview fields as the API', async () => {
		const link = await createLink('user-plus', { previewTitle: 'Hook card' });
		const image = await json(await upload('user-plus', link.id, png));
		const row = await routing()
			.prepare(
				`SELECT ${linkJson('l', 'n')} AS link FROM links l JOIN domain_namespaces n ON n.id = l.domain_id WHERE l.id = ?`
			)
			.bind(link.id)
			.first<{ link: string }>();
		const payload = JSON.parse(row?.link ?? '{}');
		expect(payload).toMatchObject({
			previewTitle: 'Hook card',
			previewDescription: null,
			previewImage: image.link.previewImage
		});
	});

	it('deletes every image of a workspace in batches, and no other', async () => {
		for (const name of ['a', 'b', 'c']) await images().put(`tenant-gone/link-1/${name}`, png);
		await images().put('tenant-stays/link-1/a', png);
		expect(await deleteTenantPreviewImages(images(), 'tenant-gone', 2)).toBe(2);
		expect(await deleteTenantPreviewImages(images(), 'tenant-gone', 2)).toBe(1);
		expect(await deleteTenantPreviewImages(images(), 'tenant-gone', 2)).toBe(0);
		expect(await images().head('tenant-stays/link-1/a')).not.toBeNull();
	});
});

describe('link cards for card bots', () => {
	let cacheCounter = 0;
	function redirects(options: { clicks?: ClickEvent[]; store?: boolean } = {}) {
		cacheCounter += 1;
		const attempts: AttemptLimiter = { limit: async () => ({ success: true }) };
		return createRedirectHandler({
			routing: routing(),
			appOrigin: origin,
			cacheName: `preview-test-${cacheCounter}`,
			clicks: options.clicks
				? {
						async send(event) {
							if (!isPageViewEvent(event)) options.clicks?.push(event);
						}
					}
				: undefined,
			linkPasswords: { keys: passwords, attempts },
			previewImages: options.store === false ? undefined : images(),
			now: () => clock
		});
	}

	const slack = 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)';
	const browser =
		'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';

	function visit(
		app: ReturnType<typeof redirects>,
		path: string,
		agent: string,
		init: RequestInit = {}
	) {
		return app.fetch(
			new Request(`https://short.example/${path}`, {
				redirect: 'manual',
				headers: { 'user-agent': agent, accept: 'text/html' },
				...init
			})
		);
	}

	it('knows the card bots and leaves search crawlers and people out', () => {
		for (const agent of [
			slack,
			'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
			'Twitterbot/1.0',
			'LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)',
			'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)',
			'TelegramBot (like TwitterBot)',
			'WhatsApp/2.23.20.0',
			'Mozilla/5.0 (Windows NT 6.1; WOW64) SkypeUriPreview Preview/0.5',
			'Mozilla/5.0 (compatible; Bluesky Cardyb/1.1; +mailto:support@bsky.app)'
		])
			expect(isCardFetcher(agent), agent).toBe(true);
		for (const agent of [
			browser,
			'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
			'curl/8.0',
			null
		])
			expect(isCardFetcher(agent), String(agent)).toBe(false);
	});

	it('gives card bots the card and people the redirect, with no click for the bot', async () => {
		const link = await createLink('user-plus', {
			title: 'Own title',
			previewTitle: 'Spring <sale>',
			previewDescription: 'Half price "until" Sunday.'
		});
		const image = (await json(await upload('user-plus', link.id, png))).link.previewImage;
		const clicks: ClickEvent[] = [];
		const app = redirects({ clicks });
		const card = await visit(app, link.slug, slack);
		expect(card.status).toBe(200);
		expect(card.headers.get('content-type')).toBe('text/html; charset=utf-8');
		expect(card.headers.get('vary')).toBe('User-Agent');
		const page = await card.text();
		expect(page).toContain('<meta property="og:title" content="Spring &lt;sale&gt;">');
		expect(page).toContain(
			'<meta property="og:description" content="Half price &quot;until&quot; Sunday.">'
		);
		expect(page).toContain(`<meta property="og:image" content="${image}">`);
		expect(page).toContain('<meta name="twitter:card" content="summary_large_image">');
		expect(page).toContain(`<meta property="og:url" content="https://short.example/${link.slug}">`);
		expect(page).not.toContain('example.com/landing');
		const head = await visit(app, link.slug, slack, { method: 'HEAD' });
		expect([head.status, await head.text()]).toEqual([200, '']);

		const person = await visit(app, link.slug, browser);
		expect(person.status).toBe(302);
		expect(person.headers.get('location')).toBe('https://example.com/landing');
		expect(person.headers.get('vary')).toBe('User-Agent');
		expect(clicks).toHaveLength(1);
	});

	it('falls back to the link title, and leaves the image out without a store', async () => {
		const link = await createLink('user-plus', { title: 'Own title' });
		await upload('user-plus', link.id, png);
		const page = await (await visit(redirects({ store: false }), link.slug, slack)).text();
		expect(page).toContain('<meta property="og:title" content="Own title">');
		expect(page).not.toContain('og:image');
		expect(page).toContain('<meta name="twitter:card" content="summary">');
	});

	it('redirects card bots for a link without a preview', async () => {
		const link = await createLink('user-plus', { title: 'Plain' });
		const response = await visit(redirects(), link.slug, slack);
		expect(response.status).toBe(302);
		expect(response.headers.get('location')).toBe('https://example.com/landing');
	});

	it('shows the card for a password link, and nothing before the start', async () => {
		const locked = await createLink('user-plus', {
			password: 'open sesame',
			previewTitle: 'Members only'
		});
		const app = redirects();
		const card = await visit(app, locked.slug, slack);
		expect(card.status).toBe(200);
		expect(await card.text()).not.toContain('example.com/landing');
		expect((await visit(app, locked.slug, browser)).status).toBe(401);
		const later = await createLink('user-plus', {
			startsAt: new Date(clock + 60_000).toISOString(),
			previewTitle: 'Soon'
		});
		const early = await visit(app, later.slug, slack);
		expect(early.status).toBe(404);
		expect(await early.text()).not.toContain('Soon');
	});

	it('serves no card and no image before the start or after the end', async () => {
		const start = clock + 60_000;
		const end = clock + 120_000;
		const link = await createLink('user-plus', {
			startsAt: new Date(start).toISOString(),
			endsAt: new Date(end).toISOString(),
			previewTitle: 'Timed card'
		});
		const url: string = (await json(await upload('user-plus', link.id, png))).link.previewImage;
		const path = new URL(url).pathname.slice(1);
		const app = redirects();
		const saved = clock;
		try {
			expect((await visit(app, path, slack)).status).toBe(404);
			clock = start;
			expect((await visit(app, path, slack)).status).toBe(200);
			expect((await visit(app, link.slug, slack)).status).toBe(200);
			clock = end;
			expect((await visit(app, path, slack)).status).toBe(404);
			const ended = await visit(app, link.slug, slack);
			expect(ended.status).toBe(410);
			expect(await ended.text()).not.toContain('Timed card');
		} finally {
			clock = saved;
		}
	});

	it('serves the image on the short-link host while the link is open', async () => {
		const link = await createLink('user-plus', { previewTitle: 'Image' });
		const url: string = (await json(await upload('user-plus', link.id, png))).link.previewImage;
		const path = new URL(url).pathname.slice(1);
		const app = redirects();
		const response = await visit(app, path, slack);
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('image/png');
		expect(response.headers.get('x-content-type-options')).toBe('nosniff');
		expect(response.headers.get('content-security-policy')).toBe("default-src 'none'");
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(png);
		const head = await visit(app, path, slack, { method: 'HEAD' });
		expect([head.status, (await head.arrayBuffer()).byteLength]).toEqual([200, 0]);
		expect(
			(await visit(app, `${link.slug}/preview/AAAAAAAAAAAAAAAAAAAAAA.png`, slack)).status
		).toBe(404);
		expect((await visit(app, `${link.slug}/preview/x.svg`, slack)).status).toBe(404);
		expect((await visit(redirects({ store: false }), path, slack)).status).toBe(404);

		// A replaced image is gone at once, even while the snapshot still names it.
		const next: string = (await json(await upload('user-plus', link.id, webp, 'image/webp'))).link
			.previewImage;
		expect((await visit(app, path, slack)).status).toBe(404);
		expect((await visit(app, new URL(next).pathname.slice(1), slack)).status).toBe(200);

		await call('user-plus', 'PATCH', `/v1/links/${link.id}`, { enabled: false });
		expect((await visit(redirects(), new URL(next).pathname.slice(1), slack)).status).toBe(404);
	});
});
