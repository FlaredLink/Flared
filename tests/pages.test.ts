// SPDX-License-Identifier: AGPL-3.0-only
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import {
	PageInputError,
	embedSource,
	hostMatches,
	isPaymentDestination,
	maxPageHandles,
	parseCreatePage,
	parseHandle,
	parseTheme,
	parseUpdatePage,
	resolveTheme
} from '../packages/contracts/src/pages';
import { deleteRoutingData } from '../packages/data/src/deletions';
import { createPage as createPageRecord } from '../packages/data/src/pages';
import { listUnprojectedLimits } from '../packages/data/src/routing-policy';
import { createTenant } from '../packages/data/src/tenancy';
import { createApi } from '../packages/server/src/api';
import { projectPolicy, retryProjections, updatePolicy } from '../packages/server/src/tenancy';

const origin = 'https://app.example';
const identity = () => env.PAGES_IDENTITY;
const routing = () => env.PAGES_ROUTING;
const stores = () => ({ routing: routing(), analytics: { 'analytics-1': env.PAGES_ANALYTICS } });
let clock = Date.UTC(2026, 10, 1, 9);

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
		pages: { host: 'pages.example' }
	});
}

let keyCounter = 0;
function call(user: string, method: string, path: string, body?: unknown) {
	keyCounter += 1;
	return api().fetch(
		new Request(`${origin}${path}`, {
			method,
			headers: {
				origin,
				'x-test-user': user,
				'idempotency-key': `page-${keyCounter}`,
				...(body === undefined ? {} : { 'content-type': 'application/json' })
			},
			body: body === undefined ? undefined : JSON.stringify(body)
		})
	);
}

async function json(response: Response) {
	return (await response.json()) as Record<string, any>;
}

async function expectError(response: Response, status: number, code: string) {
	const body = await json(response);
	expect(response.status, JSON.stringify(body)).toBe(status);
	expect(body.error.code).toBe(code);
	return body;
}

let slugCounter = 0;
async function createLink(user: string, destination = 'https://example.com/landing') {
	slugCounter += 1;
	const response = await call(user, 'POST', '/v1/links', {
		destination,
		slug: `page-${slugCounter}`
	});
	const body = await json(response);
	expect(response.status, JSON.stringify(body)).toBe(201);
	return body.link as { id: string; shortUrl: string };
}

let handleCounter = 0;
const nextHandle = () => `page-${++handleCounter}`;

async function createPage(user: string, fields: Record<string, unknown> = {}) {
	return call(user, 'POST', '/v1/pages', { handle: nextHandle(), title: 'My links', ...fields });
}

async function addTenant(userId: string, tenantId: string, pageLimit: number, pageExtras: 0 | 1) {
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
			pageLimit,
			pageExtras
		},
		now: 1
	});
	await projectPolicy(identity(), stores(), tenantId, 1);
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
	await applyD1Migrations(env.PAGES_ANALYTICS, env.ANALYTICS_MIGRATIONS, 'flared_core_migrations');
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
	await addTenant('user-plus', 'tenant-plus', 10, 1);
	await addTenant('user-free', 'tenant-free', 1, 0);
	await addTenant('user-other', 'tenant-other', 10, 1);
	await addTenant('user-off', 'tenant-off', 0, 0);
	await addTenant('user-race', 'tenant-race', 1, 0);
	await addTenant('user-squat', 'tenant-squat', 1, 0);
	await addTenant('user-gone', 'tenant-gone', 10, 1);
});

function inputField(run: () => unknown): string | null {
	try {
		run();
		return null;
	} catch (error) {
		return error instanceof PageInputError ? error.field : 'other';
	}
}

describe('page input', () => {
	it('keeps handles to lowercase letters, digits, and single hyphens', () => {
		expect(parseHandle('  My-Page ')).toBe('my-page');
		expect(parseHandle('abc')).toBe('abc');
		expect(parseHandle('a'.repeat(30))).toBe('a'.repeat(30));
		for (const handle of [
			'ab',
			'a'.repeat(31),
			'-abc',
			'abc-',
			'a--b',
			'xn--abc',
			'a_b',
			'a.b',
			'ü-page'
		])
			expect(
				inputField(() => parseHandle(handle)),
				handle
			).toBe('handle');
		expect(() => parseHandle('admin')).toThrow('reserved');
	});

	it('takes a known theme and colours as #rrggbb, and fills the rest from the preset', () => {
		expect(parseTheme(undefined)).toEqual({ id: 'paper' });
		expect(parseTheme({ id: 'ember', background: '#FFEEDD' })).toEqual({
			id: 'ember',
			background: '#ffeedd'
		});
		expect(inputField(() => parseTheme({ id: 'neon' }))).toBe('theme.id');
		expect(inputField(() => parseTheme({ id: 'ink', text: 'red' }))).toBe('theme.text');
		expect(inputField(() => parseTheme({ id: 'ink', css: 'body{}' }))).toBe('theme.css');
		expect(resolveTheme({ id: 'ink', buttonShape: 'pill' })).toMatchObject({
			background: '#111111',
			buttonShape: 'pill',
			font: 'figtree'
		});
	});

	it('keeps social addresses on the network hosts', () => {
		const page = (address: string, network = 'instagram') =>
			inputField(() =>
				parseCreatePage({
					handle: 'social',
					title: 'Social',
					blocks: [{ kind: 'social', links: [{ network, address }] }]
				})
			);
		expect(page('https://www.instagram.com/flared')).toBeNull();
		expect(page('https://instagram.com.evil.example/flared')).toBe('blocks.0.links.0.address');
		expect(page('http://instagram.com/flared')).toBe('blocks.0.links.0.address');
		expect(page('hello@example.com', 'email')).toBeNull();
		expect(page('javascript:alert(1)', 'email')).toBe('blocks.0.links.0.address');
	});

	it('builds the player address from the pasted page and refuses other addresses', () => {
		expect(embedSource('youtube', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(
			'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'
		);
		expect(embedSource('youtube', 'https://youtu.be/dQw4w9WgXcQ?t=3')).toBe(
			'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'
		);
		expect(embedSource('youtube', 'https://evil.example/watch?v=dQw4w9WgXcQ')).toBeNull();
		expect(embedSource('youtube', 'https://www.youtube.com/watch?v=bad"id')).toBeNull();
		expect(embedSource('vimeo', 'https://vimeo.com/76979871')).toBe(
			'https://player.vimeo.com/video/76979871?dnt=1'
		);
		expect(embedSource('spotify', 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC')).toBe(
			'https://open.spotify.com/embed/track/4uLU6hMCjMI75M1A2tKUQC'
		);
		expect(embedSource('calendly', 'https://calendly.com/flared/intro')).toBe(
			'https://calendly.com/flared/intro?embed_type=Inline&hide_gdpr_banner=1'
		);
		expect(embedSource('calcom', 'javascript:alert(1)')).toBeNull();
	});

	it('matches payment hosts exactly or by their wildcard', () => {
		expect(isPaymentDestination('stripe', 'https://buy.stripe.com/test_123')).toBe(true);
		expect(isPaymentDestination('stripe', 'https://buy.stripe.com.evil.example/x')).toBe(false);
		expect(isPaymentDestination('stripe', 'http://buy.stripe.com/test_123')).toBe(false);
		expect(
			isPaymentDestination('lemonsqueezy', 'https://shop.lemonsqueezy.com/checkout/buy/1')
		).toBe(true);
		expect(isPaymentDestination('lemonsqueezy', 'https://lemonsqueezy.com.evil.example/')).toBe(
			false
		);
		expect(hostMatches('evillemonsqueezy.com', ['*.lemonsqueezy.com'])).toBe(false);
	});

	it('checks block schedules and refuses an empty update', () => {
		expect(
			inputField(() =>
				parseCreatePage({
					handle: 'timed',
					title: 'Timed',
					blocks: [
						{
							kind: 'header',
							label: 'Soon',
							startsAt: '2026-11-02T00:00:00Z',
							endsAt: '2026-11-02T00:00:00Z'
						}
					]
				})
			)
		).toBe('blocks.0.endsAt');
		expect(inputField(() => parseUpdatePage({}))).toBe('body');
	});
});

describe('pages in the API', () => {
	it('creates a page with a button and reads it back', async () => {
		const link = await createLink('user-free');
		const response = await createPage('user-free', {
			bio: 'Line one\nLine two',
			theme: { id: 'ocean' },
			blocks: [
				{ kind: 'header', label: 'Start here' },
				{ kind: 'button', linkId: link.id, label: 'My site' }
			]
		});
		const body = await json(response);
		expect(response.status, JSON.stringify(body)).toBe(201);
		expect(body.page).toMatchObject({
			url: `https://${body.page.handle}.pages.example`,
			title: 'My links',
			bio: 'Line one\nLine two',
			theme: { id: 'ocean' },
			enabled: true,
			blocked: null,
			blocks: [
				{ kind: 'header', label: 'Start here', visible: true },
				{ kind: 'button', linkId: link.id, shortUrl: link.shortUrl, visible: true }
			]
		});
		const read = await json(await call('user-free', 'GET', `/v1/pages/${body.page.id}`));
		expect(read.page).toEqual(body.page);
		const list = await json(await call('user-free', 'GET', '/v1/pages'));
		expect(list.pages.map((page: { id: string }) => page.id)).toEqual([body.page.id]);
	});

	it('stops at the page limit, and refuses every page at 0', async () => {
		await expectError(await createPage('user-free'), 403, 'PAGE_LIMIT_REACHED');
		const off = await expectError(await createPage('user-off'), 403, 'PAGE_LIMIT_REACHED');
		expect(off.error.message).toBe('Your plan does not include pages.');
	});

	it('creates one page when concurrent requests race for the last place', async () => {
		const responses = await Promise.all(Array.from({ length: 5 }, () => createPage('user-race')));
		expect(responses.map((response) => response.status).sort()).toEqual([201, 403, 403, 403, 403]);
		const { results } = await routing()
			.prepare("SELECT COUNT(*) AS pages FROM pages WHERE tenant_id = 'tenant-race'")
			.all<{ pages: number }>();
		expect(results[0].pages).toBe(1);
	});

	it('needs page extras for payment, embed, and sign-up blocks and a workspace domain', async () => {
		const checkout = await createLink('user-free', 'https://buy.stripe.com/test_123');
		// Room for more pages, so only the extras decide.
		await routing()
			.prepare("UPDATE tenant_policy SET page_limit = 5 WHERE tenant_id = 'tenant-free'")
			.run();
		for (const block of [
			{ kind: 'payment', linkId: checkout.id, provider: 'stripe', label: 'Guide' },
			{ kind: 'embed', provider: 'youtube', address: 'https://youtu.be/dQw4w9WgXcQ' },
			{ kind: 'signup', label: 'News', buttonLabel: 'Join' }
		])
			await expectError(
				await createPage('user-free', { blocks: [block] }),
				403,
				'PAGE_EXTRAS_REQUIRES_PLAN'
			);
		await addWorkspaceDomain('dom-free', 'free.example', 'tenant-free');
		await expectError(
			await createPage('user-free', { domainId: 'dom-free' }),
			403,
			'PAGE_EXTRAS_REQUIRES_PLAN'
		);
		await routing()
			.prepare("UPDATE tenant_policy SET page_limit = 1 WHERE tenant_id = 'tenant-free'")
			.run();
	});

	it('shows a payment card only for a link to its provider checkout', async () => {
		const checkout = await createLink('user-plus', 'https://buy.stripe.com/test_456');
		const other = await createLink('user-plus', 'https://example.com/pay');
		await expectError(
			await createPage('user-plus', {
				blocks: [{ kind: 'payment', linkId: other.id, provider: 'stripe', label: 'Guide' }]
			}),
			422,
			'INVALID_INPUT'
		);
		const response = await createPage('user-plus', {
			blocks: [
				{
					kind: 'payment',
					linkId: checkout.id,
					provider: 'stripe',
					label: 'Guide',
					price: 'US$9'
				},
				{ kind: 'embed', provider: 'youtube', address: 'https://youtu.be/dQw4w9WgXcQ' },
				{ kind: 'signup', label: 'News', buttonLabel: 'Join' }
			]
		});
		const body = await json(response);
		expect(response.status, JSON.stringify(body)).toBe(201);
		expect(body.page.blocks[0]).toMatchObject({ kind: 'payment', price: 'US$9', visible: true });
		// A destination moved off the checkout hides the card.
		await call('user-plus', 'PATCH', `/v1/links/${checkout.id}`, {
			destination: 'https://example.com/elsewhere'
		});
		const read = await json(await call('user-plus', 'GET', `/v1/pages/${body.page.id}`));
		expect(read.page.blocks[0].visible).toBe(false);
	});

	it('hides a button while its link is off', async () => {
		const link = await createLink('user-plus');
		const body = await json(
			await createPage('user-plus', { blocks: [{ kind: 'button', linkId: link.id, label: 'Go' }] })
		);
		await call('user-plus', 'PATCH', `/v1/links/${link.id}`, { enabled: false });
		const read = await json(await call('user-plus', 'GET', `/v1/pages/${body.page.id}`));
		expect(read.page.blocks[0].visible).toBe(false);
	});
});

describe('page tenant scope', () => {
	it('refuses a button that opens another workspace link', async () => {
		const foreign = await createLink('user-other');
		const body = await expectError(
			await createPage('user-plus', {
				blocks: [{ kind: 'button', linkId: foreign.id, label: 'Theirs' }]
			}),
			422,
			'INVALID_INPUT'
		);
		expect(body.error.field).toBe('blocks.0.linkId');
	});

	it('refuses another workspace link in the database too', async () => {
		const foreign = await createLink('user-other');
		await expect(
			createPageRecord(routing(), {
				tenantId: 'tenant-plus',
				pageId: 'page-direct',
				handle: 'direct-write',
				title: 'Direct',
				bio: null,
				theme: { id: 'paper' },
				blocks: [
					{ kind: 'button', linkId: foreign.id, label: 'Theirs', startsAt: null, endsAt: null }
				],
				domainId: null,
				usesExtras: false,
				now: clock
			})
		).rejects.toThrow(/FOREIGN KEY/);
		const { results } = await routing()
			.prepare("SELECT COUNT(*) AS n FROM page_handles WHERE handle = 'direct-write'")
			.all<{ n: number }>();
		expect(results[0].n).toBe(0);
	});

	it('does not show, change, or delete another workspace page', async () => {
		const body = await json(await createPage('user-other'));
		const path = `/v1/pages/${body.page.id}`;
		await expectError(await call('user-plus', 'GET', path), 404, 'NOT_FOUND');
		await expectError(await call('user-plus', 'PATCH', path, { title: 'Mine' }), 404, 'NOT_FOUND');
		await expectError(await call('user-plus', 'DELETE', path), 404, 'NOT_FOUND');
		const list = await json(await call('user-plus', 'GET', '/v1/pages'));
		expect(list.pages.some((page: { id: string }) => page.id === body.page.id)).toBe(false);
	});

	it('shows a page on a domain of its own workspace only, one page per domain', async () => {
		await addWorkspaceDomain('dom-plus', 'plus.example', 'tenant-plus');
		await addWorkspaceDomain('dom-other', 'other.example', 'tenant-other');
		const body = await json(await createPage('user-plus', { domainId: 'dom-plus' }));
		expect(body.page).toMatchObject({ domainId: 'dom-plus', domainUrl: 'https://plus.example' });
		await expectError(
			await createPage('user-plus', { domainId: 'dom-plus' }),
			409,
			'PAGE_DOMAIN_TAKEN'
		);
		await expectError(
			await createPage('user-plus', { domainId: 'dom-other' }),
			422,
			'DOMAIN_UNAVAILABLE'
		);
	});
});

describe('page handles', () => {
	it('keeps a handle with its workspace after a rename and a delete', async () => {
		const first = await json(await createPage('user-other', { handle: 'kept-handle' }));
		await expectError(
			await createPage('user-plus', { handle: 'kept-handle' }),
			409,
			'HANDLE_TAKEN'
		);
		const renamed = await json(
			await call('user-other', 'PATCH', `/v1/pages/${first.page.id}`, { handle: 'new-handle' })
		);
		expect(renamed.page.handle).toBe('new-handle');
		// Released, yet still the other workspace's.
		await expectError(
			await createPage('user-plus', { handle: 'kept-handle' }),
			409,
			'HANDLE_TAKEN'
		);
		const reused = await createPage('user-other', { handle: 'kept-handle' });
		expect(reused.status).toBe(201);
		const deleted = await call('user-other', 'DELETE', `/v1/pages/${first.page.id}`);
		expect(deleted.status).toBe(204);
		await expectError(await createPage('user-plus', { handle: 'new-handle' }), 409, 'HANDLE_TAKEN');
		await expect(
			routing().prepare("DELETE FROM page_handles WHERE handle = 'new-handle'").run()
		).rejects.toThrow(/permanent/);
		await expect(
			routing()
				.prepare("UPDATE page_handles SET tenant_id = 'tenant-plus' WHERE handle = 'new-handle'")
				.run()
		).rejects.toThrow(/stays with its workspace/);
	});

	it('refuses a handle that another page of the same workspace holds', async () => {
		const one = await json(await createPage('user-plus', { handle: 'one-of-two' }));
		const two = await json(await createPage('user-plus', { handle: 'two-of-two' }));
		await expectError(
			await call('user-plus', 'PATCH', `/v1/pages/${two.page.id}`, { handle: 'one-of-two' }),
			409,
			'HANDLE_TAKEN'
		);
		const read = await json(await call('user-plus', 'GET', `/v1/pages/${one.page.id}`));
		expect(read.page.handle).toBe('one-of-two');
	});

	it('refuses an operator-reserved handle', async () => {
		await routing()
			.prepare("INSERT INTO reserved_handles (handle, created_at) VALUES ('brandname', 0)")
			.run();
		const body = await expectError(
			await createPage('user-plus', { handle: 'brandname' }),
			409,
			'HANDLE_TAKEN'
		);
		expect(body.error.message).toBe('This page address is reserved.');
	});

	it(`caps the handles of one workspace at ${maxPageHandles}`, async () => {
		const page = await json(await createPage('user-squat', { handle: 'squat-0' }));
		const path = `/v1/pages/${page.page.id}`;
		for (let index = 1; index < maxPageHandles; index += 1) {
			const response = await call('user-squat', 'PATCH', path, { handle: `squat-${index}` });
			expect(response.status).toBe(200);
		}
		await expectError(
			await call('user-squat', 'PATCH', path, { handle: 'squat-over' }),
			403,
			'PAGE_LIMIT_REACHED'
		);
		// A handle it had before still works.
		const back = await call('user-squat', 'PATCH', path, { handle: 'squat-0' });
		expect(back.status).toBe(200);
	});
});

describe('page plan changes', () => {
	it('keeps extras a page has after a downgrade, and refuses new ones', async () => {
		const tenantId = 'tenant-gone';
		const body = await json(
			await createPage('user-gone', {
				blocks: [{ kind: 'embed', provider: 'youtube', address: 'https://youtu.be/dQw4w9WgXcQ' }]
			})
		);
		const path = `/v1/pages/${body.page.id}`;
		clock += 1000;
		await updatePolicy(
			identity(),
			stores(),
			tenantId,
			{
				activeLinkLimit: 1000,
				monthlyClickLimit: 5000,
				retentionDays: 30,
				domainLimit: 5,
				pageLimit: 1,
				pageExtras: 0
			},
			clock
		);
		const blocks = [
			{ kind: 'embed', provider: 'youtube', address: 'https://youtu.be/dQw4w9WgXcQ' }
		];
		const kept = await call('user-gone', 'PATCH', path, { title: 'Still here', blocks });
		expect(kept.status, JSON.stringify(await kept.clone().json())).toBe(200);
		await expectError(
			await call('user-gone', 'PATCH', path, {
				blocks: [...blocks, { kind: 'signup', label: 'News', buttonLabel: 'Join' }]
			}),
			403,
			'PAGE_EXTRAS_REQUIRES_PLAN'
		);
		const removed = await call('user-gone', 'PATCH', path, { blocks: [] });
		expect(removed.status).toBe(200);
	});

	it('projects the page limit and heals a routing row from before pages', async () => {
		await routing()
			.prepare("UPDATE tenant_policy SET page_limit = NULL WHERE tenant_id = 'tenant-plus'")
			.run();
		expect(await listUnprojectedLimits(routing(), 100)).toContain('tenant-plus');
		await retryProjections(identity(), stores(), clock, 100);
		const row = await routing()
			.prepare("SELECT page_limit, page_extras FROM tenant_policy WHERE tenant_id = 'tenant-plus'")
			.first();
		expect(row).toEqual({ page_limit: 10, page_extras: 1 });
	});
});

describe('blocked pages and deletion', () => {
	it('refuses changes and deletion of a blocked page', async () => {
		const body = await json(await createPage('user-plus'));
		await routing()
			.prepare("UPDATE pages SET blocked_at = 1, blocked_reason = 'phishing' WHERE id = ?")
			.bind(body.page.id)
			.run();
		const path = `/v1/pages/${body.page.id}`;
		await expectError(
			await call('user-plus', 'PATCH', path, { title: 'New' }),
			409,
			'PAGE_BLOCKED'
		);
		await expectError(await call('user-plus', 'DELETE', path), 409, 'PAGE_BLOCKED');
		const read = await json(await call('user-plus', 'GET', path));
		expect(read.page.blocked).toEqual({ reason: 'phishing' });
	});

	it('deletes pages and blocks with the workspace and keeps the handles', async () => {
		const link = await createLink('user-other');
		await createPage('user-other', {
			handle: 'leaving-page',
			blocks: [{ kind: 'button', linkId: link.id, label: 'Go' }]
		});
		while ((await deleteRoutingData(routing(), 'tenant-other', 2)) > 0);
		const counts = await routing()
			.prepare(
				`SELECT (SELECT COUNT(*) FROM pages WHERE tenant_id = 'tenant-other') AS pages,
				(SELECT COUNT(*) FROM page_blocks WHERE tenant_id = 'tenant-other') AS blocks,
				(SELECT COUNT(*) FROM links WHERE tenant_id = 'tenant-other') AS links,
				(SELECT COUNT(*) FROM page_handles WHERE handle = 'leaving-page') AS handles`
			)
			.first();
		expect(counts).toEqual({ pages: 0, blocks: 0, links: 0, handles: 1 });
	});
});
