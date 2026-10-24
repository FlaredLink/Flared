// SPDX-License-Identifier: AGPL-3.0-only
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ClickEvent } from '../packages/contracts/src/analytics';
import { LinkInputError, parseCreateLink, parseUpdateLink } from '../packages/contracts/src/links';
import { createLinkRecord, updateLink } from '../packages/data/src/links';
import { listUnprojectedLimits } from '../packages/data/src/routing-policy';
import { linkJson } from '../packages/data/src/webhooks';
import { createTenant } from '../packages/data/src/tenancy';
import { createApi } from '../packages/server/src/api';
import {
	createLinkPasswords,
	linkPasswordIterations,
	type LinkPasswords
} from '../packages/server/src/link-passwords';
import { createRedirectHandler, type AttemptLimiter } from '../packages/server/src/redirect';
import { projectPolicy } from '../packages/server/src/tenancy';

const origin = 'https://app.example';
const identity = () => env.ACCESS_IDENTITY;
const routing = () => env.ACCESS_ROUTING;
let clock = Date.UTC(2026, 10, 1, 9);
const secret = 'test-only-link-password-secret-of-32-characters';
const passwords = createLinkPasswords(secret);

function api(options: { linkPasswords?: LinkPasswords | null } = {}) {
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
		linkPasswords: options.linkPasswords === null ? undefined : (options.linkPasswords ?? passwords)
	});
}

let keyCounter = 0;
function call(user: string, method: string, path: string, body?: unknown, app = api()) {
	keyCounter += 1;
	const headers: Record<string, string> = {
		origin,
		'x-test-user': user,
		'idempotency-key': `access-${keyCounter}`
	};
	if (body !== undefined) headers['content-type'] = 'application/json';
	return app.fetch(
		new Request(`${origin}${path}`, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body)
		})
	);
}

async function json(response: Response) {
	return (await response.json()) as Record<string, any>;
}

let slugCounter = 0;
async function createLink(user: string, fields: Record<string, unknown>) {
	slugCounter += 1;
	const response = await call(user, 'POST', '/v1/links', {
		destination: 'https://example.com/landing',
		slug: `access-${slugCounter}`,
		...fields
	});
	const body = await json(response);
	expect(response.status, JSON.stringify(body)).toBe(201);
	return body.link as { id: string; slug: string } & Record<string, unknown>;
}

async function addTenant(userId: string, tenantId: string, linkAccess: 0 | 1) {
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
			linkAccess
		},
		now: 1
	});
	await projectPolicy(
		identity(),
		{ routing: routing(), analytics: { 'analytics-1': env.ACCESS_ANALYTICS } },
		tenantId,
		1
	);
}

function storedHash(linkId: string) {
	return routing()
		.prepare('SELECT password_hash FROM links WHERE id = ?')
		.bind(linkId)
		.first<{ password_hash: string | null }>()
		.then((row) => row?.password_hash ?? null);
}

beforeAll(async () => {
	await applyD1Migrations(identity(), env.IDENTITY_MIGRATIONS, 'flared_core_migrations');
	await applyD1Migrations(routing(), env.ROUTING_MIGRATIONS, 'flared_core_migrations');
	await applyD1Migrations(env.ACCESS_ANALYTICS, env.ANALYTICS_MIGRATIONS, 'flared_core_migrations');
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

describe('link access input', () => {
	it('takes times with Z or an offset and refuses times without a zone', () => {
		const input = parseCreateLink({
			destination: 'https://example.com',
			startsAt: '2026-11-01T09:00:00+09:00',
			endsAt: '2026-11-02T00:00Z'
		});
		expect(input.startsAt).toBe(Date.UTC(2026, 10, 1, 0));
		expect(input.endsAt).toBe(Date.UTC(2026, 10, 2, 0));
		for (const value of ['2026-11-01T09:00:00', '2026-11-01', 'tomorrow', 1793000000000])
			expect(() =>
				parseCreateLink({ destination: 'https://example.com', startsAt: value })
			).toThrow(LinkInputError);
	});

	it('refuses an end before the start, a destination after no end, and a bad password', () => {
		const field = (body: Record<string, unknown>) => {
			try {
				parseCreateLink({ destination: 'https://example.com', ...body });
			} catch (error) {
				if (error instanceof LinkInputError) return error.field;
			}
			return null;
		};
		expect(field({ startsAt: '2026-11-02T00:00Z', endsAt: '2026-11-02T00:00Z' })).toBe('endsAt');
		expect(field({ endedDestination: 'https://example.com/after' })).toBe('endedDestination');
		expect(field({ password: 'abc' })).toBe('password');
		expect(field({ password: 'a'.repeat(129) })).toBe('password');
		expect(field({ password: 'four\nfive' })).toBe('password');
		expect(field({ password: ' 4 digits ' })).toBeNull();
		expect(parseUpdateLink({ password: null, endsAt: null })).toEqual({
			password: null,
			endsAt: null
		});
	});
});

describe('keyed link passwords', () => {
	it('stores a keyed hash that only the same key can check', async () => {
		const stored = await passwords.hash('open sesame');
		expect(stored).toMatch(
			new RegExp(
				`^hmac-pbkdf2-sha256\\$${linkPasswordIterations}\\$[0-9a-f]{16}\\$[0-9a-f]{32}\\$[0-9a-f]{64}$`
			)
		);
		expect(stored).not.toContain('sesame');
		expect(await passwords.verify('open sesame', stored)).toBe('match');
		expect(await passwords.verify('open sesame!', stored)).toBe('mismatch');
		// Two Unicode forms of one password match.
		expect(await passwords.verify('café', await passwords.hash('café'))).toBe('match');
		const other = createLinkPasswords('another-link-password-secret-of-32-characters');
		expect(await other.verify('open sesame', stored)).toBe('other-key');
		// The same secret with another purpose is another key.
		expect(await createLinkPasswords(secret, 'other-purpose').verify('open sesame', stored)).toBe(
			'other-key'
		);
		expect(() => createLinkPasswords('short')).toThrow();
	});

	it('checks a password in a few milliseconds', async () => {
		const stored = await passwords.hash('timing');
		const runs = 20;
		const started = performance.now();
		for (let run = 0; run < runs; run += 1) await passwords.verify('timing', stored);
		const each = (performance.now() - started) / runs;
		console.log(JSON.stringify({ event: 'link_password_check_ms', each }));
		expect(each).toBeLessThan(25);
	});
});

describe('link access in the API', () => {
	it('sets dates and a password on a plan with link access and never returns the hash', async () => {
		const link = await createLink('user-plus', {
			startsAt: '2026-11-01T00:00:00Z',
			endsAt: '2026-12-01T00:00:00Z',
			endedDestination: 'https://example.com/after',
			password: 'open sesame'
		});
		expect(link).toMatchObject({
			startsAt: '2026-11-01T00:00:00.000Z',
			endsAt: '2026-12-01T00:00:00.000Z',
			endedDestination: 'https://example.com/after',
			hasPassword: true
		});
		const read = await json(await call('user-plus', 'GET', `/v1/links/${link.id}`));
		expect(read.link.hasPassword).toBe(true);
		// The MCP tools read links through these routes, so their results carry only hasPassword too.
		const list = await call('user-plus', 'GET', '/v1/links');
		const exported = await call('user-plus', 'GET', '/v1/export/links');
		expect(list.status).toBe(200);
		expect(exported.status).toBe(200);
		// The webhook payload of a link is built in SQL.
		const payload = await routing()
			.prepare(
				`SELECT ${linkJson('l', 'n')} AS link FROM links l JOIN domain_namespaces n ON n.id = l.domain_id WHERE l.id = ?`
			)
			.bind(link.id)
			.first<{ link: string }>();
		expect(JSON.parse(payload?.link ?? '{}').hasPassword).toBe(true);
		for (const text of [
			JSON.stringify(read),
			await list.text(),
			await exported.text(),
			payload?.link ?? ''
		]) {
			expect(text).toContain(link.id);
			expect(text).not.toContain('sesame');
			expect(text).not.toContain('pbkdf2');
		}
		expect(await storedHash(link.id)).toMatch(/^hmac-pbkdf2-sha256\$5000\$/);
	});

	it('refuses new values on a plan without link access and allows clearing them', async () => {
		const refused = await call('user-free', 'POST', '/v1/links', {
			destination: 'https://example.com/free',
			password: 'open sesame'
		});
		expect(refused.status).toBe(403);
		expect((await json(refused)).error.code).toBe('LINK_ACCESS_REQUIRES_PLAN');
		const link = await createLink('user-free', {});
		const patch = await call('user-free', 'PATCH', `/v1/links/${link.id}`, {
			endsAt: '2026-12-01T00:00:00Z'
		});
		expect(patch.status).toBe(403);
		expect((await json(patch)).error.code).toBe('LINK_ACCESS_REQUIRES_PLAN');

		// A link that kept its values after a downgrade: they stay, the same value is no change,
		// and clearing works.
		await routing()
			.prepare('UPDATE links SET ends_at = ?, password_hash = ? WHERE id = ?')
			.bind(Date.UTC(2026, 11, 1), await passwords.hash('kept'), link.id)
			.run();
		const same = await call('user-free', 'PATCH', `/v1/links/${link.id}`, {
			title: 'Renamed',
			endsAt: '2026-12-01T00:00:00.000Z'
		});
		expect(same.status, JSON.stringify(await same.clone().json())).toBe(200);
		expect((await json(same)).link).toMatchObject({ title: 'Renamed', hasPassword: true });
		const cleared = await call('user-free', 'PATCH', `/v1/links/${link.id}`, {
			endsAt: null,
			password: null
		});
		expect(cleared.status).toBe(200);
		expect((await json(cleared)).link).toMatchObject({ endsAt: null, hasPassword: false });
	});

	it('checks a change against the stored dates, and clearing the end clears what follows it', async () => {
		const link = await createLink('user-plus', {
			startsAt: '2026-11-10T00:00:00Z',
			endsAt: '2026-11-20T00:00:00Z',
			endedDestination: 'https://example.com/after'
		});
		const early = await call('user-plus', 'PATCH', `/v1/links/${link.id}`, {
			endsAt: '2026-11-05T00:00:00Z'
		});
		expect(early.status).toBe(422);
		expect((await json(early)).error.field).toBe('endsAt');
		const cleared = await call('user-plus', 'PATCH', `/v1/links/${link.id}`, { endsAt: null });
		expect((await json(cleared)).link).toMatchObject({
			startsAt: '2026-11-10T00:00:00.000Z',
			endsAt: null,
			endedDestination: null
		});
	});

	it('refuses a password without the installation key and keeps the link unchanged', async () => {
		const app = api({ linkPasswords: null });
		const response = await call(
			'user-plus',
			'POST',
			'/v1/links',
			{ destination: 'https://example.com/nokey', password: 'open sesame' },
			app
		);
		expect(response.status).toBe(503);
		const link = await createLink('user-plus', {});
		const patch = await call(
			'user-plus',
			'PATCH',
			`/v1/links/${link.id}`,
			{ password: 'x1y2' },
			app
		);
		expect(patch.status).toBe(503);
		expect(await storedHash(link.id)).toBeNull();
	});

	it('marks import items that need link access in a dry run', async () => {
		const response = await call('user-free', 'POST', '/v1/links/import', {
			dryRun: true,
			items: [
				{ destination: 'https://example.com/one' },
				{ destination: 'https://example.com/two', password: 'open sesame' }
			]
		});
		const result = await json(response);
		expect(result.results.map((item: { status: string }) => item.status)).toEqual([
			'ready',
			'failed'
		]);
		expect(result.results[1].error.code).toBe('LINK_ACCESS_REQUIRES_PLAN');
	});

	it('guards link access in the database too, for a plan change during a request', async () => {
		const create = await createLinkRecord(routing(), {
			tenantId: 'tenant-free',
			key: 'race-1',
			requestHash: 'hash',
			linkId: 'race-link',
			domainId: 'dom-short',
			slug: 'race-guard',
			generatedSlug: false,
			destination: 'https://example.com/race',
			title: null,
			iosDestination: null,
			androidDestination: null,
			startsAt: null,
			endsAt: null,
			endedDestination: null,
			passwordHash: await passwords.hash('racing'),
			previewTitle: null,
			previewDescription: null,
			now: clock,
			expiresAt: clock + 60_000,
			bodies: { created: '{}', slugTaken: '{}', limitReached: '{}' },
			event: { id: 'evt-race', payload: '{}' }
		});
		expect(create.outcome).toBe('unavailable');
		const link = await createLink('user-free', {});
		const update = await updateLink(routing(), 'tenant-free', link.id, {
			passwordHash: await passwords.hash('racing'),
			now: clock,
			eventId: 'evt-race-2'
		});
		expect(update.updated).toBe(false);
	});

	it('projects link access to routing and heals rows from before it existed', async () => {
		const rows = await routing()
			.prepare(
				"SELECT tenant_id, link_access FROM tenant_policy WHERE tenant_id IN ('tenant-plus', 'tenant-free') ORDER BY tenant_id"
			)
			.all<{ tenant_id: string; link_access: number }>();
		expect(rows.results).toEqual([
			{ tenant_id: 'tenant-free', link_access: 0 },
			{ tenant_id: 'tenant-plus', link_access: 1 }
		]);
		await routing()
			.prepare("UPDATE tenant_policy SET link_access = NULL WHERE tenant_id = 'tenant-plus'")
			.run();
		expect(await listUnprojectedLimits(routing(), 10)).toContain('tenant-plus');
		await routing()
			.prepare("UPDATE tenant_policy SET link_access = 1 WHERE tenant_id = 'tenant-plus'")
			.run();
	});
});

describe('redirects with link access', () => {
	let cacheCounter = 0;

	function limiter(result: boolean | 'throw' = true) {
		const keys: string[] = [];
		const attempts: AttemptLimiter = {
			async limit({ key }) {
				keys.push(key);
				if (result === 'throw') throw new Error('limiter down');
				return { success: result };
			}
		};
		return { keys, attempts };
	}

	function redirects(
		options: {
			clicks?: ClickEvent[];
			attempts?: AttemptLimiter;
			keys?: LinkPasswords;
			noPasswords?: boolean;
		} = {}
	) {
		cacheCounter += 1;
		return createRedirectHandler({
			routing: routing(),
			appOrigin: origin,
			cacheName: `access-test-${cacheCounter}`,
			clicks: options.clicks
				? {
						async send(event) {
							options.clicks?.push(event);
						}
					}
				: undefined,
			linkPasswords: options.noPasswords
				? undefined
				: { keys: options.keys ?? passwords, attempts: options.attempts ?? limiter().attempts },
			now: () => clock
		});
	}

	const browser =
		'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
	const html = { accept: 'text/html', 'user-agent': browser };

	function visit(app: ReturnType<typeof redirects>, slug: string, init: RequestInit = {}) {
		return app.fetch(new Request(`https://short.example/${slug}`, { redirect: 'manual', ...init }));
	}

	function unlock(
		app: ReturnType<typeof redirects>,
		slug: string,
		password: string,
		headers: Record<string, string> = {}
	) {
		return visit(app, slug, {
			method: 'POST',
			headers: {
				...html,
				'content-type': 'application/x-www-form-urlencoded',
				'cf-connecting-ip': '203.0.113.7',
				...headers
			},
			body: new URLSearchParams({ password }).toString()
		});
	}

	it('opens only between the start and the end, also from a cached snapshot', async () => {
		const start = clock + 60_000;
		const end = clock + 120_000;
		const link = await createLink('user-plus', {
			startsAt: new Date(start).toISOString(),
			endsAt: new Date(end).toISOString(),
			endedDestination: 'https://example.com/after'
		});
		const clicks: ClickEvent[] = [];
		const app = redirects({ clicks });
		const early = await visit(app, link.slug, { headers: html });
		expect(early.status).toBe(404);
		expect(await early.text()).toContain('isn’t open yet');
		clock = start;
		const open = await visit(app, link.slug, { headers: html });
		expect(open.status).toBe(302);
		expect(open.headers.get('location')).toBe('https://example.com/landing');
		// The snapshot from the last visit is still fresh; the end applies anyway.
		clock = end;
		const ended = await visit(app, link.slug, { headers: html });
		expect(ended.status).toBe(302);
		expect(ended.headers.get('location')).toBe('https://example.com/after');
		expect(clicks).toHaveLength(1);
	});

	it('shows that a link ended when it has no destination for after the end', async () => {
		const link = await createLink('user-plus', { endsAt: new Date(clock - 1).toISOString() });
		const response = await visit(redirects(), link.slug, { headers: html });
		expect(response.status).toBe(410);
		expect(await response.text()).toContain('This link has ended');
		expect((await visit(redirects(), link.slug)).status).toBe(410);
	});

	it('asks for the password, and a correct one answers 303 and counts one click', async () => {
		const link = await createLink('user-plus', { password: 'open sesame' });
		const clicks: ClickEvent[] = [];
		const { keys, attempts } = limiter();
		const app = redirects({ clicks, attempts });

		const form = await visit(app, link.slug, { headers: html });
		expect(form.status).toBe(401);
		expect(form.headers.get('content-security-policy')).toContain("form-action 'self'");
		expect(form.headers.get('cache-control')).toBe('no-store');
		const page = await form.text();
		expect(page).toContain('<form method="post">');
		expect(page).not.toContain('example.com/landing');
		const head = await visit(app, link.slug, { method: 'HEAD', headers: html });
		expect([head.status, await head.text()]).toEqual([401, '']);
		const plain = await visit(app, link.slug);
		expect([plain.status, await plain.text()]).toEqual([401, 'Password required']);

		const wrong = await unlock(app, link.slug, 'open says me');
		expect(wrong.status).toBe(401);
		expect(await wrong.text()).toContain('Wrong password. Try again.');
		const right = await unlock(app, link.slug, 'open sesame');
		expect(right.status).toBe(303);
		expect(right.headers.get('location')).toBe('https://example.com/landing');
		expect(clicks).toHaveLength(1);
		expect(keys).toEqual([`${link.id}:203.0.113.7`, `${link.id}:203.0.113.7`]);

		// An automated client can open it, and no click is counted.
		const bot = await unlock(app, link.slug, 'open sesame', { 'user-agent': 'curl/8.0' });
		expect(bot.status).toBe(303);
		expect(clicks).toHaveLength(1);
	});

	it('refuses a missing or oversized password and a POST to a link without one', async () => {
		const locked = await createLink('user-plus', { password: 'open sesame' });
		const app = redirects();
		const empty = await visit(app, locked.slug, {
			method: 'POST',
			headers: { ...html, 'content-type': 'application/json' },
			body: '{"password":"open sesame"}'
		});
		expect(empty.status).toBe(400);
		expect(await empty.text()).toContain('Enter the password.');
		expect((await unlock(app, locked.slug, 'x'.repeat(3000))).status).toBe(400);
		const open = await createLink('user-plus', {});
		const post = await unlock(app, open.slug, 'anything');
		expect(post.status).toBe(405);
		expect(post.headers.get('allow')).toBe('GET, HEAD');
	});

	it('limits tries and fails closed without the limiter or the key', async () => {
		const link = await createLink('user-plus', { password: 'open sesame' });
		const limited = await unlock(
			redirects({ attempts: limiter(false).attempts }),
			link.slug,
			'open sesame'
		);
		expect(limited.status).toBe(429);
		expect(limited.headers.get('retry-after')).toBe('60');
		expect(await limited.text()).toContain('Too many tries.');
		const broken = await unlock(
			redirects({ attempts: limiter('throw').attempts }),
			link.slug,
			'open sesame'
		);
		expect(broken.status).toBe(503);
		expect((await visit(redirects({ noPasswords: true }), link.slug)).status).toBe(503);
		const otherKey = createLinkPasswords('another-link-password-secret-of-32-characters');
		expect((await unlock(redirects({ keys: otherKey }), link.slug, 'open sesame')).status).toBe(
			503
		);
	});
});
