// SPDX-License-Identifier: AGPL-3.0-only
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { listReservedSlugs, setSlugReserved } from '../packages/data/src/links';
import { createTenant } from '../packages/data/src/tenancy';
import { createApi } from '../packages/server/src/api';
import { createLink, createKeyLifetimeMs, generateSlug } from '../packages/server/src/links';
import { projectPolicy } from '../packages/server/src/tenancy';

const origin = 'https://app.example';
const identity = () => env.LINKS_IDENTITY;
const routing = () => env.LINKS_ROUTING;
let clock = Date.UTC(2026, 9, 2);

function api(options: { creationsPerMinute?: number } = {}) {
	return createApi({
		identity: identity(),
		routing: routing(),
		appOrigin: origin,
		// Test-only principal: a session for the user ID in a header the tests set.
		authenticate: async (request) => {
			const userId = request.headers.get('x-test-user');
			return userId ? { kind: 'session', userId, signedInAt: new Date(clock).toISOString() } : null;
		},
		now: () => clock,
		creationsPerMinute: options.creationsPerMinute ?? 1000
	});
}

let keyCounter = 0;
function nextKey() {
	keyCounter += 1;
	return `key-${keyCounter}`;
}

function call(
	user: string | null,
	method: string,
	path: string,
	body?: unknown,
	headers: Record<string, string> = {},
	app = api()
) {
	const init: RequestInit = { method, headers: { origin, ...headers } };
	if (user) (init.headers as Record<string, string>)['x-test-user'] = user;
	if (body !== undefined) {
		init.body = typeof body === 'string' ? body : JSON.stringify(body);
		(init.headers as Record<string, string>)['content-type'] = 'application/json';
	}
	return app.fetch(new Request(`${origin}${path}`, init));
}

function create(user: string, body: unknown, key = nextKey(), app = api()) {
	return call(user, 'POST', '/v1/links', body, { 'idempotency-key': key }, app);
}

async function json(response: Response) {
	return (await response.json()) as Record<string, any>;
}

async function addTenant(userId: string, tenantId: string, activeLinkLimit: number) {
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
		limits: { activeLinkLimit, monthlyClickLimit: 5000, retentionDays: 30, domainLimit: 1 },
		now: 1
	});
	await projectPolicy(
		identity(),
		{ routing: routing(), analytics: { 'analytics-1': env.LINKS_ANALYTICS } },
		tenantId,
		1
	);
}

async function linkCount(tenantId: string) {
	const row = await routing()
		.prepare('SELECT COUNT(*) AS n FROM links WHERE tenant_id = ?')
		.bind(tenantId)
		.first<{ n: number }>();
	return row?.n ?? -1;
}

beforeAll(async () => {
	await applyD1Migrations(identity(), env.IDENTITY_MIGRATIONS, 'flared_core_migrations');
	await applyD1Migrations(routing(), env.ROUTING_MIGRATIONS, 'flared_core_migrations');
	await applyD1Migrations(env.LINKS_ANALYTICS, env.ANALYTICS_MIGRATIONS, 'flared_core_migrations');
	await identity()
		.prepare("INSERT INTO installation (id, mode, created_at) VALUES (1, 'multi', 0)")
		.run();
	await routing().batch([
		routing().prepare(
			"INSERT INTO domain_namespaces (id, hostname, created_at) VALUES ('dom-short', 'short.example', 0), ('dom-other', 'other.example', 0)"
		),
		routing().prepare(
			"INSERT INTO domains (id, tenant_id, state, is_default, created_at, updated_at) VALUES ('dom-short', NULL, 'active', 1, 0, 0), ('dom-other', 'tenant-b', 'active', 0, 0, 0)"
		)
	]);
	await addTenant('user-a', 'tenant-a', 100);
	await addTenant('user-b', 'tenant-b', 100);
	await addTenant('user-small', 'tenant-small', 2);
	await identity()
		.prepare(
			'INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 0, 0)'
		)
		.bind('user-none', '', 'user-none@example.com')
		.run();
});

describe('link creation', () => {
	it('creates a link with a generated slug on the default domain', async () => {
		const response = await create('user-a', { destination: 'https://example.com/launch?x=1' });
		expect(response.status).toBe(201);
		expect(response.headers.get('cache-control')).toBe('no-store');
		const { link } = await json(response);
		expect(link.slug).toMatch(/^[a-z0-9]{7}$/);
		expect(link.shortUrl).toBe(`https://short.example/${link.slug}`);
		expect(link).toMatchObject({
			domainId: 'dom-short',
			destination: 'https://example.com/launch?x=1',
			title: null,
			enabled: true
		});
		const fetched = await call('user-a', 'GET', `/v1/links/${link.id}`);
		expect((await json(fetched)).link).toEqual(link);
	});

	it('replays a stored result and refuses a reused key with other input', async () => {
		const key = nextKey();
		const body = { destination: 'https://example.com/replay', slug: 'replay-me', title: 'Replay' };
		const first = await create('user-a', body, key);
		const second = await create('user-a', body, key);
		expect(first.status).toBe(201);
		expect(second.status).toBe(201);
		expect(second.headers.get('idempotent-replayed')).toBe('true');
		expect(await second.text()).toBe(await first.text());
		const reused = await create('user-a', { ...body, title: 'Other' }, key);
		expect(reused.status).toBe(409);
		expect((await json(reused)).error.code).toBe('IDEMPOTENCY_KEY_REUSED');
		const countRow = await routing()
			.prepare("SELECT COUNT(*) AS n FROM links WHERE slug = 'replay-me'")
			.first<{ n: number }>();
		expect(countRow?.n).toBe(1);
	});

	it('lets a key be used again after it expires', async () => {
		const key = nextKey();
		expect((await create('user-a', { destination: 'https://example.com/a' }, key)).status).toBe(
			201
		);
		clock += createKeyLifetimeMs + 1;
		expect((await create('user-a', { destination: 'https://example.com/b' }, key)).status).toBe(
			201
		);
	});

	it('gives a contested custom slug to exactly one request', async () => {
		const responses = await Promise.all(
			['user-a', 'user-b', 'user-a', 'user-b'].map((user) =>
				create(user, { destination: 'https://example.com/race', slug: 'race-slug' })
			)
		);
		const statuses = responses.map((response) => response.status).sort();
		expect(statuses).toEqual([201, 409, 409, 409]);
		for (const response of responses.filter((r) => r.status === 409))
			expect((await json(response)).error).toMatchObject({ code: 'SLUG_TAKEN', field: 'slug' });
	});

	it('stops at the active link limit under concurrent requests and stores the rejection', async () => {
		const keys = Array.from({ length: 5 }, () => nextKey());
		const responses = await Promise.all(
			keys.map((key, index) =>
				create('user-small', { destination: `https://example.com/${index}` }, key)
			)
		);
		expect(responses.map((response) => response.status).sort()).toEqual([201, 201, 403, 403, 403]);
		expect(await linkCount('tenant-small')).toBe(2);
		const rejectedIndex = responses.findIndex((response) => response.status === 403);
		const rejectedBody = await responses[rejectedIndex].text();
		expect(JSON.parse(rejectedBody).error.code).toBe('PLAN_LIMIT_REACHED');

		const created = await json(responses.find((response) => response.status === 201) as Response);
		const disabled = await call('user-small', 'PATCH', `/v1/links/${created.link.id}`, {
			enabled: false
		});
		expect((await json(disabled)).link.enabled).toBe(false);

		// A stored rejection replays even after room frees up; new attempts need a new key.
		const replayed = await create(
			'user-small',
			{ destination: `https://example.com/${rejectedIndex}` },
			keys[rejectedIndex]
		);
		expect(replayed.status).toBe(403);
		expect(await replayed.text()).toBe(rejectedBody);
		const fresh = await create('user-small', { destination: 'https://example.com/fresh' });
		expect(fresh.status).toBe(201);

		const reactivated = await call('user-small', 'PATCH', `/v1/links/${created.link.id}`, {
			enabled: true
		});
		expect(reactivated.status).toBe(403);
		expect((await json(reactivated)).error.code).toBe('PLAN_LIMIT_REACHED');
	});

	it('allows only one reactivation when two race for the last slot', async () => {
		const page = await json(await call('user-small', 'GET', '/v1/links'));
		const active = page.links.filter((link: { enabled: boolean }) => link.enabled);
		await call('user-small', 'PATCH', `/v1/links/${active[0].id}`, { enabled: false });
		const disabled = (await json(await call('user-small', 'GET', '/v1/links'))).links.filter(
			(link: { enabled: boolean }) => !link.enabled
		);
		expect(disabled).toHaveLength(2);
		const responses = await Promise.all(
			disabled.map((link: { id: string }) =>
				call('user-small', 'PATCH', `/v1/links/${link.id}`, { enabled: true })
			)
		);
		expect(responses.map((response) => response.status).sort()).toEqual([200, 403]);
	});

	it('keeps a slug reserved after its link is disabled', async () => {
		const { link } = await json(
			await create('user-a', { destination: 'https://example.com/keep', slug: 'keep-me' })
		);
		await call('user-a', 'PATCH', `/v1/links/${link.id}`, { enabled: false });
		const again = await create('user-b', { destination: 'https://example.com/x', slug: 'keep-me' });
		expect(again.status).toBe(409);
		await expect(
			routing().prepare("DELETE FROM slug_reservations WHERE slug = 'keep-me'").run()
		).rejects.toThrow();
		await expect(
			routing().prepare("UPDATE links SET slug = 'moved' WHERE slug = 'keep-me'").run()
		).rejects.toThrow();
	});

	it('retries a generated slug that collides', async () => {
		const slugs = ['replay-me', 'fresh01'];
		const result = await createLink(routing(), {
			tenantId: 'tenant-a',
			key: nextKey(),
			input: { destination: 'https://example.com/retry', slug: null, title: null, domainId: null },
			requestId: 'request-1',
			now: clock,
			newSlug: () => slugs.shift() ?? 'unused',
			newId: () => crypto.randomUUID()
		});
		expect(result.status).toBe(201);
		expect(JSON.parse(result.body).link.slug).toBe('fresh01');
	});

	it('keeps an operator-reserved slug off the platform domain only, until it is removed', async () => {
		const existing = await create('user-a', {
			destination: 'https://example.com/in-use',
			slug: 'in-use'
		});
		expect(existing.status).toBe(201);
		expect(await setSlugReserved(routing(), 'brandword', true, clock)).toBe(true);
		expect(await setSlugReserved(routing(), 'brandword', true, clock)).toBe(false);
		expect(await setSlugReserved(routing(), 'in-use', true, clock)).toBe(true);
		const refused = await create('user-a', {
			destination: 'https://example.com/b',
			slug: 'brandword'
		});
		expect(refused.status).toBe(409);
		expect((await json(refused)).error.code).toBe('SLUG_TAKEN');
		const own = await create('user-b', {
			destination: 'https://example.com/b',
			slug: 'brandword',
			domainId: 'dom-other'
		});
		expect(own.status).toBe(201);
		const generated = ['brandword', 'fresh02'];
		const result = await createLink(routing(), {
			tenantId: 'tenant-a',
			key: nextKey(),
			input: { destination: 'https://example.com/g', slug: null, title: null, domainId: null },
			requestId: 'request-2',
			now: clock,
			newSlug: () => generated.shift() ?? 'unused',
			newId: () => crypto.randomUUID()
		});
		expect(JSON.parse(result.body).link.slug).toBe('fresh02');
		expect(await listReservedSlugs(routing())).toEqual([
			{ slug: 'brandword', createdAt: clock, taken: false },
			{ slug: 'in-use', createdAt: clock, taken: true }
		]);
		const redirect = await routing()
			.prepare("SELECT status FROM links WHERE slug = 'in-use'")
			.first<{ status: string }>();
		expect(redirect?.status).toBe('active');
		expect(await setSlugReserved(routing(), 'brandword', false, clock)).toBe(true);
		expect(await setSlugReserved(routing(), 'in-use', false, clock)).toBe(true);
		expect(
			(await create('user-a', { destination: 'https://example.com/b', slug: 'brandword' })).status
		).toBe(201);
		expect(
			(await create('user-b', { destination: 'https://example.com/b', slug: 'in-use' })).status
		).toBe(409);
	});

	it('generates seven characters from the slug alphabet', () => {
		for (let index = 0; index < 50; index += 1) expect(generateSlug()).toMatch(/^[a-z0-9]{7}$/);
	});
});

describe('domains', () => {
	it('uses only an active domain the tenant may use', async () => {
		const own = await create('user-b', {
			destination: 'https://example.com',
			domainId: 'dom-other'
		});
		expect(own.status).toBe(201);
		expect((await json(own)).link.shortUrl).toMatch(/^https:\/\/other\.example\//);
		const foreign = await create('user-a', {
			destination: 'https://example.com',
			domainId: 'dom-other'
		});
		expect(foreign.status).toBe(422);
		expect((await json(foreign)).error.code).toBe('DOMAIN_UNAVAILABLE');
	});

	it('lists only the links on one domain, and none for another tenant’s domain', async () => {
		await create('user-b', {
			destination: 'https://example.com/a',
			slug: 'on-other',
			domainId: 'dom-other'
		});
		await create('user-b', { destination: 'https://example.com/b', slug: 'on-short' });
		const other = await json(await call('user-b', 'GET', '/v1/links?limit=100&domain=dom-other'));
		expect(other.links.map((link: { slug: string }) => link.slug)).toContain('on-other');
		expect(
			other.links.every((link: { hostname: string }) => link.hostname === 'other.example')
		).toBe(true);
		const short = await json(await call('user-b', 'GET', '/v1/links?limit=100&domain=dom-short'));
		expect(short.links.some((link: { slug: string }) => link.slug === 'on-other')).toBe(false);
		expect(short.links.some((link: { slug: string }) => link.slug === 'on-short')).toBe(true);
		const foreign = await json(await call('user-a', 'GET', '/v1/links?limit=100&domain=dom-other'));
		expect(foreign.links).toEqual([]);
		expect((await call('user-b', 'GET', `/v1/links?domain=${'x'.repeat(65)}`)).status).toBe(422);
	});

	it('reports an unavailable default domain without storing the result', async () => {
		await routing().prepare("UPDATE domains SET state = 'disabled' WHERE id = 'dom-short'").run();
		const key = nextKey();
		const response = await create('user-a', { destination: 'https://example.com/d' }, key);
		await routing().prepare("UPDATE domains SET state = 'active' WHERE id = 'dom-short'").run();
		expect(response.status).toBe(409);
		expect((await json(response)).error.code).toBe('DEFAULT_DOMAIN_UNAVAILABLE');
		expect((await create('user-a', { destination: 'https://example.com/d' }, key)).status).toBe(
			201
		);
	});
});

describe('access', () => {
	it('requires a session and the exact origin before any write', async () => {
		const before = await linkCount('tenant-a');
		expect((await call(null, 'GET', '/v1/links')).status).toBe(401);
		for (const headers of [{ origin: 'https://evil.example' }, { origin: 'null' }]) {
			const response = await call(
				'user-a',
				'POST',
				'/v1/links',
				{ destination: 'https://e.com' },
				{
					...headers,
					'idempotency-key': nextKey()
				}
			);
			expect(response.status).toBe(403);
			expect((await json(response)).error.code).toBe('ORIGIN_REJECTED');
		}
		const missing = await api().fetch(
			new Request(`${origin}/v1/links`, {
				method: 'POST',
				headers: {
					'x-test-user': 'user-a',
					'content-type': 'application/json',
					'idempotency-key': 'k'
				},
				body: JSON.stringify({ destination: 'https://e.com' })
			})
		);
		expect(missing.status).toBe(403);
		expect(await linkCount('tenant-a')).toBe(before);
	});

	it('hides other tenants’ links', async () => {
		const { link } = await json(
			await create('user-a', { destination: 'https://example.com/private' })
		);
		expect((await call('user-b', 'GET', `/v1/links/${link.id}`)).status).toBe(404);
		expect(
			(
				await call('user-b', 'PATCH', `/v1/links/${link.id}`, {
					destination: 'https://evil.example'
				})
			).status
		).toBe(404);
		const list = await json(await call('user-b', 'GET', '/v1/links?limit=100'));
		expect(list.links.some((item: { id: string }) => item.id === link.id)).toBe(false);
		expect((await json(await call('user-a', 'GET', `/v1/links/${link.id}`))).link.destination).toBe(
			'https://example.com/private'
		);
	});

	it('refuses users without a ready workspace', async () => {
		const none = await call('user-none', 'GET', '/v1/links');
		expect(none.status).toBe(403);
		expect((await json(none)).error.code).toBe('NO_WORKSPACE');
		await identity()
			.prepare(
				'INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 0, 0)'
			)
			.bind('user-pending', '', 'user-pending@example.com')
			.run();
		await createTenant(identity(), {
			id: 'tenant-pending',
			name: 'Workspace',
			ownerUserId: 'user-pending',
			analyticsShardId: 'analytics-1',
			limits: { activeLinkLimit: 1, monthlyClickLimit: 1, retentionDays: 1, domainLimit: 0 },
			now: 1
		});
		const pending = await call('user-pending', 'GET', '/v1/links');
		expect(pending.status).toBe(503);
		expect(pending.headers.get('retry-after')).toBe('30');
	});

	it('rate-limits creation per tenant', async () => {
		const app = api({ creationsPerMinute: 2 });
		clock += 60000;
		const statuses = [];
		for (let index = 0; index < 3; index += 1)
			statuses.push(
				(await create('user-b', { destination: `https://example.com/r${index}` }, nextKey(), app))
					.status
			);
		expect(statuses).toEqual([201, 201, 429]);
	});
});

describe('validation', () => {
	it('rejects bad input with stable codes and stores nothing', async () => {
		const before = await linkCount('tenant-a');
		const cases: [unknown, string][] = [
			[{ destination: 'javascript:alert(1)' }, 'INVALID_INPUT'],
			[{ destination: 'https://user:pass@example.com' }, 'INVALID_INPUT'],
			[{ destination: 'example.com' }, 'INVALID_INPUT'],
			[{ destination: `https://example.com/${'a'.repeat(4096)}` }, 'INVALID_INPUT'],
			[{ destination: 'https://example.com', slug: 'pricing' }, 'INVALID_INPUT'],
			[{ destination: 'https://example.com', slug: 'Upper' }, 'INVALID_INPUT'],
			[{ destination: 'https://example.com', slug: '-edge' }, 'INVALID_INPUT'],
			[{ destination: 'https://example.com', slug: 'ab' }, 'INVALID_INPUT'],
			[{ destination: 'https://example.com', extra: true }, 'INVALID_INPUT'],
			['{not json', 'INVALID_INPUT']
		];
		for (const [body, code] of cases) {
			const response = await create('user-a', body);
			expect(response.status, JSON.stringify(body)).toBe(422);
			expect((await json(response)).error.code).toBe(code);
		}
		const field = await create('user-a', { destination: 'ftp://example.com' });
		expect((await json(field)).error.field).toBe('destination');
		const noKey = await call('user-a', 'POST', '/v1/links', { destination: 'https://example.com' });
		expect((await json(noKey)).error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
		const large = await create(
			'user-a',
			JSON.stringify({ destination: 'https://e.com', title: 'x'.repeat(9000) })
		);
		expect(large.status).toBe(413);
		expect(await linkCount('tenant-a')).toBe(before);
	});

	it('pages newest first and escapes search wildcards', async () => {
		for (const slug of ['page-one', 'page-two', 'page-three']) {
			clock += 1;
			await create('user-b', { destination: 'https://example.com/p', slug, title: '100% off' });
		}
		const first = await json(await call('user-b', 'GET', '/v1/links?limit=2&q=page-'));
		expect(first.links.map((link: { slug: string }) => link.slug)).toEqual([
			'page-three',
			'page-two'
		]);
		const second = await json(
			await call(
				'user-b',
				'GET',
				`/v1/links?limit=2&q=page-&cursor=${encodeURIComponent(first.nextCursor)}`
			)
		);
		expect(second.links.map((link: { slug: string }) => link.slug)).toEqual(['page-one']);
		expect(second.nextCursor).toBeNull();
		const percent = await json(await call('user-b', 'GET', '/v1/links?q=100%25'));
		expect(percent.links).toHaveLength(3);
		const wildcard = await json(await call('user-b', 'GET', '/v1/links?q=%25'));
		expect(wildcard.links).toHaveLength(3);
		expect((await call('user-b', 'GET', '/v1/links?cursor=bad')).status).toBe(422);
		expect((await call('user-b', 'GET', '/v1/links?limit=101')).status).toBe(422);
	});

	it('edits the destination and clears the title', async () => {
		const { link } = await json(
			await create('user-a', { destination: 'https://example.com/old', title: 'Old' })
		);
		const response = await call('user-a', 'PATCH', `/v1/links/${link.id}`, {
			destination: 'https://example.com/new',
			title: null
		});
		expect((await json(response)).link).toMatchObject({
			destination: 'https://example.com/new',
			title: null,
			slug: link.slug
		});
		expect((await call('user-a', 'PATCH', `/v1/links/${link.id}`, {})).status).toBe(422);
		expect((await call('user-a', 'DELETE', `/v1/links/${link.id}`)).status).toBe(405);
	});
});
