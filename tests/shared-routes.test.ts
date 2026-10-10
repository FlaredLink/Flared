// SPDX-License-Identifier: AGPL-3.0-only
// The routes every edition composes, against real D1: the shared auth routes with a test
// sign-in route, the passkey budget, the job ledger, the account deletion route, the OAuth
// discovery documents, the API session lookup, and the application-side auth forwarder.
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { betterAuth } from 'better-auth';
import { emailOTP } from 'better-auth/plugins';
import { createIdentityAdapter } from '../packages/data/src/identity-adapter';
import {
	installD1ProofGuards,
	withIdentityProofScope
} from '../packages/data/src/identity-proof-guards';
import { createTenant } from '../packages/data/src/tenancy';
import { deleteAccount, type AccountDeletionEdition } from '../packages/server/src/account';
import { apiAuthenticator, sessionPrincipal } from '../packages/server/src/api/compose';
import type { ApiTokenAuth } from '../packages/server/src/auth/api-tokens';
import { checkedTableName, consumePasskeyBudget } from '../packages/server/src/auth/limits';
import { createSessionOptions } from '../packages/server/src/auth/options';
import { createPasskeyPlugin } from '../packages/server/src/auth/passkey';
import { authenticated, createAuthRoutes } from '../packages/server/src/auth/routes';
import { exactRecord } from '../packages/server/src/auth/validation';
import { createJobLedger } from '../packages/server/src/jobs';
import {
	aiCatalogDocument,
	protectedResourceDocument,
	serverCardDocument
} from '../packages/server/src/oauth/handler';
import { forwardAuthRoute, sharedAuthMethods } from '../packages/server/src/web/auth';
import {
	assertion,
	attestation,
	newAuthenticator,
	type Authenticator
} from './support/authenticator';

const origin = 'https://app.example';
const secret = 'test-only-auth-secret-at-least-thirty-two-characters';
const rateLimitSecret = 'test-only-rate-limit-secret-at-least-32-characters';
const db = () => env.SHARED_IDENTITY;
const codes = new Map<string, string>();

async function createInstance() {
	const instance = betterAuth({
		...createSessionOptions(origin),
		secret,
		database: createIdentityAdapter(db()),
		verification: { disableCleanup: true },
		rateLimit: { enabled: false },
		logger: { disabled: true },
		plugins: [
			emailOTP({
				expiresIn: 300,
				allowedAttempts: 3,
				storeOTP: 'hashed',
				async sendVerificationOTP({ email, otp }) {
					codes.set(email, otp);
				}
			}),
			createPasskeyPlugin(origin, 'Flared')
		]
	});
	installD1ProofGuards(await instance.$context, db());
	return instance;
}

// A test edition: one route signs in with an email code in a single request.
const app = () => {
	const instance = createInstance();
	return createAuthRoutes({
		auth: () => instance,
		db: db(),
		origin,
		rateLimitSecret,
		passkeyAttemptsTable: 'test_passkey_attempts',
		identityRule: { kind: 'verified-email' },
		signIn: {
			methods: { '/api/auth/test/sign-in': 'POST' },
			async handle({ body, headers }) {
				const email = exactRecord(body, ['email']).email;
				if (typeof email !== 'string') throw new Error('Test email missing');
				const { api } = await instance;
				await withIdentityProofScope('issue', () =>
					api.sendVerificationOTP({ body: { email, type: 'sign-in' }, headers })
				);
				const otp = codes.get(email) ?? '';
				const result = await withIdentityProofScope('verify', () =>
					api.signInEmailOTP({ body: { email, otp }, headers, asResponse: true })
				);
				return authenticated(result);
			}
		}
	});
};

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

let sourceCounter = 0;
async function call(
	jar: Jar,
	path: string,
	body?: unknown,
	options: { source?: string | null; origin?: string; raw?: string } = {}
) {
	sourceCounter += 1;
	const headers = new Headers({ origin: options.origin ?? origin, cookie: jar.header() });
	const source =
		options.source === undefined ? `198.51.100.${sourceCounter % 250}` : options.source;
	if (source) headers.set('x-flared-source', source);
	const payload = options.raw ?? (body === undefined ? undefined : JSON.stringify(body));
	if (payload !== undefined) headers.set('content-type', 'application/json');
	const response = await app().fetch(
		new Request(origin + path, {
			method: payload === undefined ? 'GET' : 'POST',
			headers,
			body: payload
		})
	);
	jar.take(response);
	return response;
}

async function json(response: Response): Promise<Record<string, any>> {
	return (await response.json()) as Record<string, any>;
}

async function signIn(email: string): Promise<Jar> {
	const jar = new Jar();
	expect((await call(jar, '/api/auth/test/sign-in', { email })).status).toBe(200);
	return jar;
}

async function makeStale(email: string) {
	await db()
		.prepare(
			'UPDATE session SET createdAt = ? WHERE userId = (SELECT id FROM user WHERE email = ?)'
		)
		.bind(Date.now() - 601000, email)
		.run();
}

async function addPasskey(jar: Jar, device: Authenticator, name = 'Laptop') {
	const issued = await call(jar, '/api/auth/passkey/register/options', {});
	if (issued.status !== 200) return issued;
	const { options } = await json(issued);
	return call(jar, '/api/auth/passkey/register/verify', {
		response: await attestation(device, options.challenge),
		name
	});
}

async function passkeySignIn(jar: Jar, device: Authenticator) {
	const issued = await call(jar, '/api/auth/passkey/sign-in/options', {});
	expect(issued.status).toBe(200);
	const { options } = await json(issued);
	return call(jar, '/api/auth/passkey/sign-in/verify', {
		response: await assertion(device, options.challenge)
	});
}

let owner: Jar;
let device: Authenticator;

beforeAll(async () => {
	await applyD1Migrations(db(), env.IDENTITY_MIGRATIONS);
	await db()
		.prepare(
			'CREATE TABLE test_passkey_attempts (id TEXT PRIMARY KEY NOT NULL, source_key TEXT NOT NULL, created_at INTEGER NOT NULL, utc_day INTEGER NOT NULL)'
		)
		.run();
	owner = await signIn('owner@example.com');
	device = await newAuthenticator(origin);
});

describe('shared auth routes', () => {
	it('reads the session and answers only listed routes and methods', async () => {
		const session = await json(await call(owner, '/api/auth/session'));
		expect(session.user.email).toBe('owner@example.com');
		expect((await call(new Jar(), '/api/auth/session')).status).toBe(401);
		const unknown = await call(owner, '/api/auth/sign-up/email', { email: 'x@example.com' });
		expect(unknown.status).toBe(404);
		expect((await call(owner, '/api/auth/passkeys', {})).status).toBe(405);
		const wrong = await call(owner, '/api/auth/sign-out');
		expect(wrong.status).toBe(405);
		expect(wrong.headers.get('allow')).toBe('POST');
		expect(wrong.headers.get('cache-control')).toBe('no-store');
	});

	it('adds a passkey after a fresh sign-in and signs in with it', async () => {
		const issued = await call(owner, '/api/auth/passkey/register/options', {});
		expect(issued.status).toBe(200);
		const cookies = issued.headers.getSetCookie().map((cookie) => cookie.split('=')[0]);
		expect(cookies).toEqual(['__Secure-better-auth.better-auth-passkey']);
		const { options } = await json(issued);
		expect(options.rp.id).toBe('app.example');
		const added = await call(owner, '/api/auth/passkey/register/verify', {
			response: await attestation(device, options.challenge),
			name: 'Laptop'
		});
		expect(await json(added)).toEqual({ ok: true });
		const { passkeys } = await json(await call(owner, '/api/auth/passkeys'));
		expect(passkeys).toHaveLength(1);
		expect(Object.keys(passkeys[0]).sort()).toEqual(['backedUp', 'createdAt', 'id', 'name']);

		const visitor = new Jar();
		const response = await passkeySignIn(visitor, device);
		expect(await json(response)).toEqual({ ok: true });
		expect((await json(await call(visitor, '/api/auth/session'))).user.email).toBe(
			'owner@example.com'
		);
		const unknown = await passkeySignIn(new Jar(), await newAuthenticator(origin));
		expect((await json(unknown)).error.code).toBe('PASSKEY_REJECTED');
	});

	it('re-authenticates with a passkey of the signed-in user only', async () => {
		const jar = await signIn('confirm@example.com');
		const own = await newAuthenticator(origin);
		expect((await addPasskey(jar, own)).status).toBe(200);
		await makeStale('confirm@example.com');
		expect((await addPasskey(jar, await newAuthenticator(origin))).status).toBe(403);
		async function confirm(key: Authenticator) {
			const issued = await call(jar, '/api/auth/reauth/passkey/options', {});
			expect(issued.status).toBe(200);
			const { options } = await json(issued);
			return call(jar, '/api/auth/reauth/passkey/verify', {
				response: await assertion(key, options.challenge)
			});
		}
		const foreign = await confirm(device);
		expect((await json(foreign)).error.code).toBe('PASSKEY_REJECTED');
		expect(foreign.headers.getSetCookie()).toEqual([]);
		expect((await call(jar, '/api/auth/session').then(json)).user.email).toBe(
			'confirm@example.com'
		);
		expect((await confirm(own)).status).toBe(200);
		expect(
			Date.parse((await json(await call(jar, '/api/auth/passkeys'))).freshUntil)
		).toBeGreaterThan(Date.now());
		expect((await call(new Jar(), '/api/auth/reauth/passkey/options', {})).status).toBe(401);
	});

	it('renames with any session, deletes only with a fresh one, and hides other passkeys', async () => {
		const jar = await signIn('manager@example.com');
		const own = await newAuthenticator(origin);
		expect((await addPasskey(jar, own)).status).toBe(200);
		const [passkey] = (await json(await call(jar, '/api/auth/passkeys'))).passkeys;
		const intruder = await signIn('intruder@example.com');
		expect((await call(intruder, '/api/auth/passkey/delete', { id: passkey.id })).status).toBe(404);
		await makeStale('manager@example.com');
		expect(
			(await call(jar, '/api/auth/passkey/rename', { id: passkey.id, name: 'Phone' })).status
		).toBe(200);
		expect((await call(jar, '/api/auth/passkey/delete', { id: passkey.id })).status).toBe(403);
		const fresh = await signIn('manager@example.com');
		expect((await call(fresh, '/api/auth/passkey/delete', { id: passkey.id })).status).toBe(200);
		expect((await passkeySignIn(new Jar(), own)).status).toBe(400);
	});

	it('checks Origin, body size, input shape, and the source address', async () => {
		const jar = await signIn('checks@example.com');
		const foreign = await call(jar, '/api/auth/sign-out', {}, { origin: 'https://evil.example' });
		expect(foreign.status).toBe(403);
		expect((await json(foreign)).error.code).toBe('INVALID_ORIGIN');
		const large = await call(jar, '/api/auth/sign-out', undefined, { raw: 'x'.repeat(5000) });
		expect(large.status).toBe(413);
		expect((await call(jar, '/api/auth/sign-out', { extra: 1 })).status).toBe(400);
		expect(
			(await call(new Jar(), '/api/auth/passkey/sign-in/options', {}, { source: 'spoof' })).status
		).toBe(503);
		expect((await call(new Jar(), '/api/auth/passkey/register/options', {})).status).toBe(401);
	});

	it('signs out and ends the session', async () => {
		const jar = await signIn('leaving@example.com');
		const out = await call(jar, '/api/auth/sign-out', {});
		expect(await json(out)).toEqual({ ok: true });
		expect((await call(jar, '/api/auth/session')).status).toBe(401);
	});
});

describe('passkey budget', () => {
	it('limits sign-in options per source in the edition table and refuses other names', async () => {
		const source = '203.0.113.9';
		for (let attempt = 0; attempt < 30; attempt += 1)
			expect(
				(await call(new Jar(), '/api/auth/passkey/sign-in/options', {}, { source })).status
			).toBe(200);
		const limited = await call(new Jar(), '/api/auth/passkey/sign-in/options', {}, { source });
		expect(limited.status).toBe(429);
		expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
		const stored = await db()
			.prepare('SELECT COUNT(*) AS n FROM test_passkey_attempts WHERE source_key LIKE ?')
			.bind('%203.0.113.9%')
			.first<{ n: number }>();
		expect(stored?.n).toBe(0);
		for (const name of ['', 'Upper', 'a b', 'x;DROP TABLE user', `a${'b'.repeat(63)}`])
			expect(() => checkedTableName(name), name).toThrow();
		await expect(
			consumePasskeyBudget(db(), 'x;--', rateLimitSecret, source, Date.now())
		).rejects.toThrow('Invalid table name');
	});
});

describe('job ledger', () => {
	const identity = () => env.JOBS_IDENTITY;
	const ledger = createJobLedger({
		table: 'test_job_status',
		frequent: ['every_ten'],
		daily: ['once_a_day']
	});
	beforeAll(async () => {
		await identity()
			.prepare(
				"CREATE TABLE test_job_status (job TEXT PRIMARY KEY NOT NULL, last_started_at INTEGER NOT NULL, last_finished_at INTEGER NOT NULL, last_outcome TEXT NOT NULL CHECK (last_outcome IN ('succeeded','failed')), last_success_at INTEGER, failures INTEGER NOT NULL DEFAULT 0)"
			)
			.run();
	});

	it('records outcomes, counts failures since the last success, and marks missed jobs', async () => {
		let clock = 1_000_000;
		const now = () => clock;
		await ledger.trackJob(identity(), 'every_ten', async () => {}, now);
		clock += 1000;
		await expect(
			ledger.trackJob(
				identity(),
				'every_ten',
				async () => {
					throw new Error('boom');
				},
				now
			)
		).rejects.toThrow('boom');
		const [frequent, daily] = await ledger.readJobStatuses(identity(), clock);
		expect(frequent).toMatchObject({
			job: 'every_ten',
			lastOutcome: 'failed',
			lastSuccessAt: 1_000_000,
			failures: 1,
			missed: false
		});
		expect(daily).toMatchObject({ job: 'once_a_day', lastFinishedAt: null, missed: false });
		const later = await ledger.readJobStatuses(identity(), clock + 26 * 60 * 1000);
		expect(later[0].missed).toBe(true);
		expect(ledger.isJobName('once_a_day')).toBe(true);
		expect(ledger.isJobName('other')).toBe(false);
		expect(() => createJobLedger({ table: 'bad name', frequent: [], daily: [] })).toThrow();
	});
});

describe('account deletion route', () => {
	const identity = () => env.ACCOUNT_IDENTITY;
	const fresh = new Date().toISOString();
	const started: string[] = [];
	let refusal = false;
	const edition: AccountDeletionEdition = {
		async confirmation(store, userId) {
			const row = await store
				.prepare('SELECT name FROM "user" WHERE id = ?')
				.bind(userId)
				.first<{ name: string }>();
			return row?.name || null;
		},
		mismatchMessage: 'Type your name.',
		suspendedMessage: 'Suspended.',
		async refuse() {
			return refusal ? { code: 'EDITION_REFUSED', status: 409, message: 'Not now.' } : null;
		}
	};
	function remove(userId: string, confirmation: string, headers: HeadersInit = {}) {
		return deleteAccount(
			new Request(`${origin}/api/account/delete`, {
				method: 'POST',
				headers: { origin, 'content-type': 'application/json', ...headers },
				body: JSON.stringify({ confirmation })
			}),
			{
				identity: identity(),
				appOrigin: origin,
				authenticate: async () => ({
					kind: 'session',
					sessionId: 'session-test',
					userId,
					signedInAt: fresh
				}),
				start: (tenantId) => started.push(tenantId),
				edition
			}
		);
	}
	beforeAll(async () => {
		await applyD1Migrations(identity(), env.IDENTITY_MIGRATIONS);
		await identity()
			.prepare("INSERT INTO installation (id, mode, created_at) VALUES (1, 'multi', 0)")
			.run();
		// The second owner has no confirmation value in this edition.
		for (const [name, label] of [
			['owner', 'owner'],
			['blank', '']
		]) {
			await identity()
				.prepare(
					'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 0, 0)'
				)
				.bind(`user-${name}`, label, `${name}@example.com`)
				.run();
			await createTenant(identity(), {
				id: `t-${name}`,
				name: 'Workspace',
				ownerUserId: `user-${name}`,
				analyticsShardId: 'analytics-1',
				limits: { activeLinkLimit: 10, monthlyClickLimit: 10, retentionDays: 30, domainLimit: 1 },
				now: 1
			});
		}
	});

	it('takes the edition confirmation and refusal, then starts the job', async () => {
		expect((await remove('user-owner', 'owner', { origin: 'https://evil.example' })).status).toBe(
			403
		);
		const blank = await remove('user-blank', '');
		expect((await json(blank)).error.code).toBe('OWNER_REQUIRED');
		expect((await json(await remove('user-none', 'x'))).error.code).toBe('NO_WORKSPACE');
		const mismatch = await remove('user-owner', 'owner@example.com');
		expect(await json(mismatch)).toMatchObject({
			error: { code: 'CONFIRMATION_MISMATCH', message: 'Type your name.' }
		});
		refusal = true;
		const refused = await remove('user-owner', 'OWNER');
		expect(refused.status).toBe(409);
		expect((await json(refused)).error.code).toBe('EDITION_REFUSED');
		expect(started).toEqual([]);
		refusal = false;
		const accepted = await remove('user-owner', 'OWNER');
		expect(accepted.status).toBe(202);
		expect(started).toEqual(['t-owner']);
	});
});

describe('discovery documents', () => {
	const resource = 'https://app.example/mcp';
	it('serves protected resource metadata, the server card, and the AI catalog', async () => {
		const get = new Request(`${origin}/x`);
		const metadata = await protectedResourceDocument(get, resource, origin).json();
		expect(metadata).toMatchObject({ resource, authorization_servers: [origin] });
		const card = await serverCardDocument(get, resource).json();
		expect(card).toMatchObject({ transport: { endpoint: resource } });
		const catalog = aiCatalogDocument(get, { origin, resource, displayName: 'Flared' });
		expect(catalog.headers.get('access-control-allow-origin')).toBe('*');
		expect(await catalog.json()).toMatchObject({
			host: { displayName: 'Flared', identifier: 'did:web:app.example' },
			entries: [{ url: `${origin}/.well-known/mcp/server-card.json` }]
		});
		const post = serverCardDocument(new Request(`${origin}/x`, { method: 'POST' }), resource);
		expect(post.status).toBe(405);
	});
});

describe('API authentication', () => {
	const session = {
		user: { id: 'user-1', email: 'a@example.com', name: 'a@example.com' },
		sessionId: 'session-1',
		expiresAt: 'x',
		signedInAt: '2026-10-07T00:00:00.000Z'
	};
	const auth = {
		async fetch(request: Request) {
			if (request.headers.get('cookie') === 'good') return Response.json(session);
			return Response.json({ error: { code: 'UNAUTHENTICATED' } }, { status: 401 });
		}
	};
	it('reads only the cookie in session mode and only the bearer token in bearer mode', async () => {
		const withCookie = new Request(`${origin}/v1/me`, { headers: { cookie: 'good' } });
		expect(await sessionPrincipal(withCookie, auth, origin)).toEqual({
			kind: 'session',
			userId: 'user-1',
			sessionId: 'session-1',
			signedInAt: session.signedInAt
		});
		expect(await sessionPrincipal(new Request(`${origin}/v1/me`), auth, origin)).toBeNull();
		// Bearer mode returns before it reads a token from a request without Authorization.
		const tokenAuth = {} as ApiTokenAuth;
		const bearer = apiAuthenticator('bearer', {
			identity: db(),
			tokenAuth,
			auth,
			origin
		});
		expect(await bearer(withCookie)).toBeNull();
	});
});

describe('auth forwarding', () => {
	const routes = {
		methods: { ...sharedAuthMethods, '/api/auth/test/sign-in': 'POST' as const },
		sourceLimited: (path: string) => path === '/api/auth/passkey/sign-in/options'
	};
	const seen: Request[] = [];
	const service = {
		async fetch(request: Request) {
			seen.push(request);
			return Response.json({ ok: true }, { headers: { 'set-cookie': 'a=b' } });
		}
	};
	it('forwards listed routes with fixed headers and the trusted source', async () => {
		const forward = (path: string, init: RequestInit = {}, address: string | null = '192.0.2.1') =>
			forwardAuthRoute(new Request(`${origin}${path}`, init), service, address, routes);
		expect((await forward('/api/auth/admin/list-users')).status).toBe(404);
		expect((await forward('/api/auth/session', { method: 'POST' })).status).toBe(405);
		expect(
			(await forward('/api/auth/passkey/sign-in/options', { method: 'POST', body: '{}' }, null))
				.status
		).toBe(503);
		const response = await forward('/api/auth/test/sign-in', {
			method: 'POST',
			headers: { origin, 'content-type': 'application/json', authorization: 'Bearer x' },
			body: '{}'
		});
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('no-store');
		const upstream = seen.at(-1);
		expect(upstream?.headers.get('x-flared-source')).toBe('192.0.2.1');
		expect(upstream?.headers.get('authorization')).toBeNull();
	});
});
