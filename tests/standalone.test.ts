// SPDX-License-Identifier: AGPL-3.0-only
// The standalone owner against real D1: protected setup (claims, resumes, closing), username
// sign-in under the proof guards, request budgets, reauthentication, password change, the
// owner identity rule, and the single-workspace binding of the API, redirects, and clicks.
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ClickEvent } from '../packages/contracts/src/analytics';
import { readSetupClaim, readSetupState } from '../packages/data/src/setup';
import { createTenant } from '../packages/data/src/tenancy';
import { createClickConsumer, type QueueMessage } from '../packages/server/src/analytics';
import { createApi } from '../packages/server/src/api';
import {
	createOwnerAuth,
	createOwnerAuthRoutes,
	ownerEmail,
	type OwnerAuth
} from '../packages/server/src/auth/owner';
import { readPrincipal } from '../packages/server/src/auth/session';
import { createOAuthRoutes } from '../packages/server/src/oauth/routes';
import { createRedirectHandler } from '../packages/server/src/redirect';
import { handleSetup, type SetupOptions } from '../packages/server/src/setup';

const origin = 'https://flared.example.workers.dev';
const host = 'flared.example.workers.dev';
const config = {
	origin,
	secret: 'test-only-auth-secret-at-least-thirty-two-characters',
	rateLimitSecret: 'test-only-rate-limit-secret-at-least-32-characters'
};
const setupSecret = 'test-only-setup-secret-with-at-least-32-bytes';
const limits = {
	activeLinkLimit: 10000,
	monthlyClickLimit: 50000,
	retentionDays: 30,
	domainLimit: 5
};
const password = 'correct horse battery';
const owner = { secret: setupSecret, username: 'Owner.One', password, workspaceName: 'Links' };

function setupOptions(identity: D1Database, change: Partial<SetupOptions> = {}): SetupOptions {
	return {
		identity,
		routing: env.SETUP_ROUTING,
		analytics: { 'analytics-1': env.SETUP_ANALYTICS },
		analyticsShardId: 'analytics-1',
		config,
		setupSecret,
		limits,
		...change
	};
}

let sourceCounter = 0;
function nextSource() {
	sourceCounter += 1;
	return `198.51.${Math.floor(sourceCounter / 250)}.${sourceCounter % 250}`;
}

function setupRequest(body: unknown, options: { source?: string; from?: string } = {}) {
	return new Request(`${origin}/api/setup`, {
		method: 'POST',
		headers: {
			origin: options.from ?? origin,
			'content-type': 'application/json',
			'x-flared-source': options.source ?? nextSource()
		},
		body: JSON.stringify(body)
	});
}

async function code(response: Response): Promise<string | undefined> {
	const body = (await response.clone().json()) as { error?: { code?: string } };
	return body.error?.code;
}

async function count(db: D1Database, sql: string): Promise<number> {
	const row = await db.prepare(sql).first<{ n: number }>();
	return row?.n ?? -1;
}

// Fails the n-th batch call and passes every other call through.
function failOnBatch(db: D1Database, n: number): D1Database {
	let calls = 0;
	return new Proxy(db, {
		get(target, property) {
			if (property === 'batch')
				return async (statements: D1PreparedStatement[]) => {
					calls += 1;
					if (calls === n) throw new Error('Injected batch failure');
					return target.batch(statements);
				};
			const value: unknown = Reflect.get(target, property);
			return typeof value === 'function' ? value.bind(target) : value;
		}
	});
}

beforeAll(async () => {
	for (const db of [
		env.OWNER_IDENTITY,
		env.SETUP_RACE_IDENTITY,
		env.SETUP_RESUME_IDENTITY,
		env.SETUP_MULTI_IDENTITY,
		env.SETUP_CLOSED_IDENTITY
	])
		await applyD1Migrations(db, env.IDENTITY_MIGRATIONS);
	for (const db of [env.OWNER_ROUTING, env.SETUP_ROUTING])
		await applyD1Migrations(db, env.ROUTING_MIGRATIONS);
	for (const db of [env.OWNER_ANALYTICS, env.SETUP_ANALYTICS])
		await applyD1Migrations(db, env.ANALYTICS_MIGRATIONS);
});

describe('setup', () => {
	const closed = () => env.SETUP_CLOSED_IDENTITY;

	it('refuses requests before the secret proof, and needs a usable secret', async () => {
		const db = closed();
		expect(await readSetupState(db)).toBe('unclaimed');
		const get = await handleSetup(new Request(`${origin}/api/setup`), setupOptions(db));
		expect(get.status).toBe(405);
		expect(
			await code(await handleSetup(setupRequest(owner, { from: 'null' }), setupOptions(db)))
		).toBe('INVALID_ORIGIN');
		for (const body of [
			{ ...owner, password: 'short' },
			{ ...owner, username: 'no spaces allowed' },
			{ ...owner, workspaceName: '  ' },
			{ ...owner, extra: true }
		])
			expect((await handleSetup(setupRequest(body), setupOptions(db))).status).toBe(400);
		for (const secret of [null, 'too-short', config.secret])
			expect(
				await code(
					await handleSetup(setupRequest(owner), setupOptions(db, { setupSecret: secret }))
				)
			).toBe('SETUP_UNAVAILABLE');
		expect(await readSetupState(db)).toBe('unclaimed');
	});

	it('limits secret attempts per source before comparing', async () => {
		const db = closed();
		const source = '203.0.113.50';
		for (let attempt = 0; attempt < 5; attempt += 1)
			expect(
				await code(
					await handleSetup(
						setupRequest({ ...owner, secret: 'x'.repeat(40) }, { source }),
						setupOptions(db)
					)
				)
			).toBe('SETUP_SECRET_INVALID');
		const limited = await handleSetup(setupRequest(owner, { source }), setupOptions(db));
		expect(limited.status).toBe(429);
		expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
		expect(await readSetupState(db)).toBe('unclaimed');
	});

	it('creates the owner and workspace, signs in, and closes for good', async () => {
		const db = closed();
		const created = await handleSetup(setupRequest(owner), setupOptions(db));
		expect(created.status).toBe(200);
		expect(created.headers.getSetCookie().some((cookie) => cookie.includes('session_token='))).toBe(
			true
		);
		expect(await readSetupState(db)).toBe('active');
		const claim = await readSetupClaim(db);
		expect(claim).toMatchObject({ step: 4, state: 'active', passwordHash: null });
		const user = await db
			.prepare('SELECT email, emailVerified, username, displayUsername FROM "user"')
			.first();
		expect(user).toEqual({
			email: ownerEmail(claim?.userId ?? ''),
			emailVerified: 0,
			username: 'owner.one',
			displayUsername: 'Owner.One'
		});
		expect(
			await count(db, "SELECT COUNT(*) AS n FROM owner_audit WHERE action = 'setup_activated'")
		).toBe(1);
		const domain = await env.SETUP_ROUTING.prepare(
			'SELECT d.state, d.is_default, d.tenant_id FROM domains d JOIN domain_namespaces n ON n.id = d.id WHERE n.hostname = ?'
		)
			.bind(host)
			.first();
		expect(domain).toEqual({ state: 'active', is_default: 1, tenant_id: null });

		// The same request again, a new instance, a removed owner account, and a deleted workspace
		// all find setup closed.
		expect(await code(await handleSetup(setupRequest(owner), setupOptions(db)))).toBe(
			'SETUP_CLOSED'
		);
		const fresh = setupOptions(db, { auth: () => createOwnerAuth(db, config) });
		expect(await code(await handleSetup(setupRequest(owner), fresh))).toBe('SETUP_CLOSED');
		await db.prepare('DELETE FROM session').run();
		await db.prepare('DELETE FROM account').run();
		expect(await code(await handleSetup(setupRequest(owner), setupOptions(db)))).toBe(
			'SETUP_CLOSED'
		);
		await db.prepare('UPDATE installation SET closed_at = 1 WHERE id = 1').run();
		expect(await readSetupState(db)).toBe('closed');
		expect(await code(await handleSetup(setupRequest(owner), setupOptions(db)))).toBe(
			'SETUP_CLOSED'
		);
		await expect(
			db.prepare("UPDATE installation_setup SET state = 'initializing'").run()
		).rejects.toThrow();
		await expect(db.prepare('DELETE FROM installation_setup').run()).rejects.toThrow();
	});

	it('creates one owner and one workspace under concurrent requests', async () => {
		const db = env.SETUP_RACE_IDENTITY;
		const responses = await Promise.all(
			[1, 2, 3, 4].map(() => handleSetup(setupRequest(owner), setupOptions(db)))
		);
		expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200]);
		expect(await count(db, 'SELECT COUNT(*) AS n FROM "user"')).toBe(1);
		expect(await count(db, 'SELECT COUNT(*) AS n FROM account')).toBe(1);
		expect(await count(db, 'SELECT COUNT(*) AS n FROM tenants')).toBe(1);
		expect(await count(db, 'SELECT COUNT(*) AS n FROM tenant_memberships')).toBe(1);
		expect(await readSetupState(db)).toBe('active');
		const other = await handleSetup(
			setupRequest({ ...owner, username: 'someone' }),
			setupOptions(db)
		);
		expect(await code(other)).toBe('SETUP_CLOSED');
		// The database keeps one tenant in single mode.
		await db
			.prepare(
				"INSERT INTO \"user\" (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('intruder', '', 'i@example.com', 1, 0, 0)"
			)
			.run();
		await expect(
			createTenant(db, {
				id: 'second',
				name: 'Second',
				ownerUserId: 'intruder',
				analyticsShardId: 'analytics-1',
				limits,
				now: 1
			})
		).rejects.toThrow();
	});

	it('resumes after a failure at each step, only for the same owner', async () => {
		const db = env.SETUP_RESUME_IDENTITY;
		const auth = () => createOwnerAuth(db, config);
		// Batch 2 is the owner account after the claim.
		const first = await handleSetup(
			setupRequest(owner),
			setupOptions(failOnBatch(db, 2), { auth })
		);
		expect(await code(first)).toBe('SETUP_UNAVAILABLE');
		expect((await readSetupClaim(db))?.step).toBe(0);
		const claim = await readSetupClaim(db);

		expect(
			await code(
				await handleSetup(setupRequest({ ...owner, username: 'someone' }), setupOptions(db))
			)
		).toBe('SETUP_CLAIMED');
		expect(
			await code(
				await handleSetup(
					setupRequest({ ...owner, password: 'another long password' }),
					setupOptions(db)
				)
			)
		).toBe('SETUP_CLAIMED');
		expect(
			await code(
				await handleSetup(
					setupRequest({ ...owner, workspaceName: 'Changed' }),
					setupOptions(failOnBatch(db, 2), { auth })
				)
			)
		).toBe('SETUP_UNAVAILABLE');
		expect((await readSetupClaim(db))?.step).toBe(1);

		const broken = env.SETUP_BROKEN;
		expect(
			await code(await handleSetup(setupRequest(owner), setupOptions(db, { routing: broken })))
		).toBe('SETUP_UNAVAILABLE');
		expect((await readSetupClaim(db))?.step).toBe(2);
		expect(
			await code(
				await handleSetup(
					setupRequest(owner),
					setupOptions(db, { analytics: { 'analytics-1': broken } })
				)
			)
		).toBe('SETUP_UNAVAILABLE');
		expect((await readSetupClaim(db))?.step).toBe(3);
		expect(await readSetupState(db)).toBe('initializing');

		const done = await handleSetup(setupRequest(owner), setupOptions(db));
		expect(done.status).toBe(200);
		const final = await readSetupClaim(db);
		expect(final).toMatchObject({
			claimId: claim?.claimId,
			userId: claim?.userId,
			tenantId: claim?.tenantId,
			workspaceName: 'Links',
			state: 'active'
		});
		expect(await count(db, 'SELECT COUNT(*) AS n FROM tenants')).toBe(1);
		const installation = await db.prepare('SELECT mode, fixed_tenant_id FROM installation').first();
		expect(installation).toEqual({ mode: 'single', fixed_tenant_id: claim?.tenantId });
	});

	it('refuses an identity store of a multi-workspace installation', async () => {
		const db = env.SETUP_MULTI_IDENTITY;
		await db
			.prepare("INSERT INTO installation (id, mode, created_at) VALUES (1, 'multi', 0)")
			.run();
		expect(await readSetupState(db)).toBe('misconfigured');
		expect(await code(await handleSetup(setupRequest(owner), setupOptions(db)))).toBe(
			'SETUP_UNAVAILABLE'
		);
	});
});

// The owner of OWNER_IDENTITY, set up once.
const db = () => env.OWNER_IDENTITY;
let shared: Promise<OwnerAuth> | undefined;
const sharedAuth = () => (shared ??= createOwnerAuth(db(), config));
const routes = (auth: () => Promise<OwnerAuth> = sharedAuth) =>
	createOwnerAuthRoutes({ db: db(), config, auth });

class Jar {
	cookies = new Map<string, string>();
	take(response: Response) {
		for (const cookie of response.headers.getSetCookie()) {
			const [pair] = cookie.split(';');
			const at = pair.indexOf('=');
			this.cookies.set(pair.slice(0, at), pair.slice(at + 1));
		}
	}
	header() {
		return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
	}
}

async function call(
	jar: Jar,
	path: string,
	body?: unknown,
	options: { source?: string; app?: ReturnType<typeof routes> } = {}
) {
	const headers = new Headers({ origin, cookie: jar.header() });
	headers.set('x-flared-source', options.source ?? nextSource());
	if (body !== undefined) headers.set('content-type', 'application/json');
	const response = await (options.app ?? routes()).fetch(
		new Request(origin + path, {
			method: body === undefined ? 'GET' : 'POST',
			headers,
			body: body === undefined ? undefined : JSON.stringify(body)
		})
	);
	jar.take(response);
	return response;
}

async function signIn(name = 'owner.one', secret = password): Promise<Jar> {
	const jar = new Jar();
	const response = await call(jar, '/api/auth/sign-in/password', {
		username: name,
		password: secret
	});
	expect(response.status).toBe(200);
	return jar;
}

async function makeStale() {
	await db()
		.prepare('UPDATE session SET createdAt = ?')
		.bind(Date.now() - 601000)
		.run();
}

let tenantId = '';
let userId = '';

describe('owner sign-in', () => {
	beforeAll(async () => {
		const response = await handleSetup(
			setupRequest(owner),
			setupOptions(db(), {
				routing: env.OWNER_ROUTING,
				analytics: { 'analytics-1': env.OWNER_ANALYTICS },
				auth: sharedAuth
			})
		);
		expect(response.status).toBe(200);
		const claim = await readSetupClaim(db());
		tenantId = claim?.tenantId ?? '';
		userId = claim?.userId ?? '';
	});

	it('signs in by username without touching verification storage', async () => {
		const jar = await signIn('OWNER.ONE');
		const session = (await (await call(jar, '/api/auth/session')).json()) as {
			user: { id: string; email: string; name: string };
		};
		expect(session.user).toEqual({ id: userId, email: ownerEmail(userId), name: 'owner.one' });
		for (const body of [
			{ username: 'owner.one', password: 'wrong password!' },
			{ username: 'nobody', password },
			{ username: 'x', password }
		]) {
			const refused = await call(new Jar(), '/api/auth/sign-in/password', body);
			expect(refused.status, body.username).toBe(401);
			expect(await code(refused)).toBe('INVALID_CREDENTIALS');
			expect(refused.headers.getSetCookie()).toEqual([]);
		}
		expect(
			(await call(new Jar(), '/api/auth/sign-in/password', { username: 'owner.one' })).status
		).toBe(400);
		expect(await count(db(), 'SELECT COUNT(*) AS n FROM verification')).toBe(0);
	});

	it('reserves the sign-in budget before hashing, also under concurrency', async () => {
		const source = '203.0.113.77';
		const responses = await Promise.all(
			Array.from({ length: 12 }, () =>
				call(
					new Jar(),
					'/api/auth/sign-in/password',
					{ username: 'owner.one', password: 'nope nope nope' },
					{ source }
				)
			)
		);
		const statuses = responses.map((response) => response.status).sort();
		expect(statuses.filter((status) => status === 401)).toHaveLength(10);
		expect(statuses.filter((status) => status === 429)).toHaveLength(2);
		const right = await call(
			new Jar(),
			'/api/auth/sign-in/password',
			{ username: 'owner.one', password },
			{ source }
		);
		expect(right.status).toBe(429);
	});

	it('offers no sign-up, email, reset, or linking path', async () => {
		const { api } = await sharedAuth();
		await expect(
			api.signUpEmail({ body: { email: 'new@example.com', password, name: 'New' } })
		).rejects.toThrow();
		await expect(
			api.signInEmail({ body: { email: ownerEmail(userId), password } })
		).rejects.toThrow();
		await expect(
			api.requestPasswordReset({ body: { email: ownerEmail(userId) } })
		).rejects.toThrow();
		for (const path of [
			'/api/auth/sign-up/email',
			'/api/auth/sign-in/email',
			'/api/auth/sign-in/username',
			'/api/auth/is-username-available',
			'/api/auth/request-password-reset',
			'/api/auth/reset-password',
			'/api/auth/link-social',
			'/api/auth/update-user',
			'/api/auth/change-password'
		])
			expect((await call(new Jar(), path, {})).status, path).toBe(404);
		expect(await count(db(), 'SELECT COUNT(*) AS n FROM "user"')).toBe(1);
	});

	it('re-authenticates only the signed-in owner by password', async () => {
		const ctx = await (await sharedAuth()).$context;
		await db()
			.prepare(
				"INSERT INTO \"user\" (id, name, email, emailVerified, username, createdAt, updatedAt) VALUES ('other', 'other', 'other@owner.invalid', 0, 'other.user', 0, 0)"
			)
			.run();
		await db()
			.prepare(
				"INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt) VALUES ('other-account', 'other', 'credential', 'other', ?, 0, 0)"
			)
			.bind(await ctx.password.hash('other password 123'))
			.run();
		const jar = await signIn();
		await makeStale();
		expect((await call(jar, '/api/auth/passkey/register/options', {})).status).toBe(403);
		expect(
			(await call(jar, '/api/auth/reauth/password', { password: 'other password 123' })).status
		).toBe(401);
		expect(
			(await call(jar, '/api/auth/reauth/password', { password: 'wrong wrong wrong' })).status
		).toBe(401);
		const confirmed = await call(jar, '/api/auth/reauth/password', { password });
		expect(confirmed.status).toBe(200);
		const session = (await (await call(jar, '/api/auth/session')).json()) as {
			user: { id: string };
		};
		expect(session.user.id).toBe(userId);
		const options = await call(jar, '/api/auth/passkey/register/options', {});
		expect(options.status).toBe(200);
		const body = (await options.json()) as { options: { user: { name: string } } };
		expect(body.options.user.name).toBe('owner.one');
		expect((await call(new Jar(), '/api/auth/reauth/password', { password })).status).toBe(401);
		await db().prepare("DELETE FROM account WHERE id = 'other-account'").run();
		await db().prepare('DELETE FROM "user" WHERE id = \'other\'').run();
	});

	it('changes the password and ends every session', async () => {
		const first = await signIn();
		const second = await signIn();
		await makeStale();
		const stale = await call(first, '/api/auth/password/change', {
			currentPassword: password,
			newPassword: 'a new long password'
		});
		expect(await code(stale)).toBe('REAUTH_REQUIRED');
		const current = await signIn();
		expect(
			(
				await call(current, '/api/auth/password/change', {
					currentPassword: 'wrong wrong',
					newPassword: 'a new long password'
				})
			).status
		).toBe(401);
		expect(
			(
				await call(current, '/api/auth/password/change', {
					currentPassword: password,
					newPassword: 'short'
				})
			).status
		).toBe(400);
		const before = current.header();
		const changed = await call(current, '/api/auth/password/change', {
			currentPassword: password,
			newPassword: 'a new long password'
		});
		expect(changed.status).toBe(200);
		expect(current.header()).not.toBe(before);
		expect((await call(current, '/api/auth/session')).status).toBe(200);
		for (const jar of [first, second])
			expect((await call(jar, '/api/auth/session')).status).toBe(401);
		expect(
			(await call(new Jar(), '/api/auth/sign-in/password', { username: 'owner.one', password }))
				.status
		).toBe(401);
		expect(
			await count(db(), "SELECT COUNT(*) AS n FROM owner_audit WHERE action = 'password_changed'")
		).toBe(1);

		// A failure after the update leaves no session behind; the new password works.
		const failing = async (): Promise<OwnerAuth> => {
			const instance = await createOwnerAuth(db(), config);
			Object.defineProperty(instance.api, 'signInUsername', {
				value: async () => {
					throw new Error('Injected sign-in failure');
				}
			});
			return instance;
		};
		const again = await signIn('owner.one', 'a new long password');
		const broken = await call(
			again,
			'/api/auth/password/change',
			{ currentPassword: 'a new long password', newPassword: 'the final password' },
			{ app: routes(failing) }
		);
		expect(broken.status).toBe(503);
		expect(await count(db(), 'SELECT COUNT(*) AS n FROM session')).toBe(0);
		await signIn('owner.one', 'the final password');
	});

	it('reads the owner only under the owner rule, and OAuth consent accepts it', async () => {
		const jar = await signIn('owner.one', 'the final password');
		const reader = await sharedAuth();
		const headers = new Headers({ cookie: jar.header() });
		expect(await readPrincipal(reader.api, headers, { kind: 'verified-email' })).toBeNull();
		expect(
			(await readPrincipal(reader.api, headers, { kind: 'owner-username', db: db() }))?.user.name
		).toBe('owner.one');
		const oauth = (rule: Parameters<typeof readPrincipal>[2]) =>
			createOAuthRoutes({
				db: db(),
				config: {
					origin,
					secret: config.secret,
					resource: `${origin}/mcp`,
					loginPath: '/app/login',
					consentPath: '/app/oauth/consent',
					fetchClientMetadata: fetch
				},
				sourceKey: async () => 'source',
				identityRule: rule
			});
		const consent = new Request(`${origin}/oauth2/consent/request?client_id=x`, {
			headers: { cookie: jar.header() }
		});
		expect((await oauth({ kind: 'verified-email' }).fetch(consent.clone())).status).toBe(401);
		const accepted = await oauth({ kind: 'owner-username', db: db() }).fetch(consent);
		expect(accepted.status).toBe(400);
	});
});

describe('single-workspace binding', () => {
	it('refuses other tenants in the API, redirects, and the click consumer', async () => {
		const principal = { kind: 'session' as const, userId, signedInAt: new Date().toISOString() };
		const api = (fixedTenantId: string) =>
			createApi({
				identity: db(),
				routing: env.OWNER_ROUTING,
				analytics: { 'analytics-1': env.OWNER_ANALYTICS },
				appOrigin: origin,
				authenticate: async () => principal,
				fixedTenantId
			});
		const foreign = await api('another-tenant').fetch(new Request(`${origin}/v1/links`));
		expect(await code(foreign)).toBe('NO_WORKSPACE');
		const created = await api(tenantId).fetch(
			new Request(`${origin}/v1/links`, {
				method: 'POST',
				headers: {
					origin,
					'content-type': 'application/json',
					'idempotency-key': crypto.randomUUID()
				},
				body: JSON.stringify({ destination: 'https://example.com/landing', slug: 'first-link' })
			})
		);
		expect(created.status).toBe(201);
		const { link } = (await created.json()) as { link: { shortUrl: string } };
		// The app's own paths on the one host can never become slugs.
		for (const slug of ['mcp', 'oauth2', 'healthz', 'setup']) {
			const refused = await api(tenantId).fetch(
				new Request(`${origin}/v1/links`, {
					method: 'POST',
					headers: {
						origin,
						'content-type': 'application/json',
						'idempotency-key': crypto.randomUUID()
					},
					body: JSON.stringify({ destination: 'https://example.com/', slug })
				})
			);
			expect(refused.status, slug).toBe(422);
		}
		expect(link.shortUrl).toBe(`${origin}/first-link`);

		const redirect = (fixedTenantId: string) =>
			createRedirectHandler({
				routing: env.OWNER_ROUTING,
				appOrigin: origin,
				cacheName: 'standalone-binding',
				fixedTenantId
			});
		const visit = () => new Request(`${origin}/first-link`);
		expect((await redirect(tenantId).fetch(visit())).status).toBe(302);
		// The cached snapshot is checked too.
		expect((await redirect('another-tenant').fetch(visit())).status).toBe(404);

		const event: ClickEvent = {
			schemaVersion: 1,
			eventId: crypto.randomUUID(),
			tenantId: 'another-tenant',
			analyticsShardId: 'analytics-1',
			linkId: 'link-1',
			kind: 'production',
			occurredAt: Date.now(),
			country: 'DE',
			deviceCategory: 'desktop',
			referrerHostname: 'unknown'
		};
		let acked = false;
		const message: QueueMessage = {
			body: event,
			ack: () => {
				acked = true;
			},
			retry: () => {}
		};
		const results = await createClickConsumer({
			shards: { 'analytics-1': env.OWNER_ANALYTICS },
			fixedTenantId: tenantId
		})({ messages: [message] });
		expect(results).toEqual(['dropped']);
		expect(acked).toBe(true);
	});
});
