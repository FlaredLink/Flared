// SPDX-License-Identifier: AGPL-3.0-only
// API tokens with the pinned API-key plugin under workerd and D1.
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { betterAuth } from 'better-auth';
import { scopePresets, type CreateTokenInput } from '../packages/contracts/src/tokens';
import { createIdentityAdapter } from '../packages/data/src/identity-adapter';
import { createTenant } from '../packages/data/src/tenancy';
import { deleteExpiredApiTokens } from '../packages/data/src/tokens';
import { createSessionOptions } from '../packages/server/src/auth/options';
import {
	TokenLimitError,
	createApiTokenPlugin,
	createToken,
	listTokens,
	revokeToken,
	verifyToken
} from '../packages/server/src/auth/api-tokens';
import { projectPolicy } from '../packages/server/src/tenancy';
import { authenticateBearer, createApi } from '../packages/server/src/api';

const origin = 'https://app.example';
const identity = () => env.TOKENS_IDENTITY;

function auth() {
	return betterAuth({
		...createSessionOptions(origin),
		secret: 'test-only-auth-secret-at-least-thirty-two-characters',
		database: createIdentityAdapter(identity()),
		rateLimit: { enabled: false },
		logger: { disabled: true },
		plugins: [createApiTokenPlugin()]
	});
}

const input: CreateTokenInput = { name: 'CI', scopes: scopePresets.read, expiresInDays: 90 };

async function addTenant(userId: string, tenantId: string) {
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
		limits: { activeLinkLimit: 100, monthlyClickLimit: 5000, retentionDays: 30, domainLimit: 1 },
		now: 1
	});
	await projectPolicy(
		identity(),
		{ routing: env.TOKENS_ROUTING, analytics: { 'analytics-1': env.TOKENS_ANALYTICS } },
		tenantId,
		1
	);
}

beforeAll(async () => {
	await applyD1Migrations(identity(), env.IDENTITY_MIGRATIONS, 'flared_core_migrations');
	await identity()
		.prepare("INSERT INTO installation (id, mode, created_at) VALUES (1, 'multi', 0)")
		.run();
	await applyD1Migrations(env.TOKENS_ROUTING, env.ROUTING_MIGRATIONS, 'flared_core_migrations');
	await applyD1Migrations(env.TOKENS_ANALYTICS, env.ANALYTICS_MIGRATIONS, 'flared_core_migrations');
	await env.TOKENS_ROUTING.batch([
		env.TOKENS_ROUTING.prepare(
			"INSERT INTO domain_namespaces (id, hostname, created_at) VALUES ('dom-short', 'short.example', 0)"
		),
		env.TOKENS_ROUTING.prepare(
			"INSERT INTO domains (id, tenant_id, state, is_default, created_at, updated_at) VALUES ('dom-short', NULL, 'active', 1, 0, 0)"
		)
	]);
	for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9]) await addTenant(`user-${n}`, `tenant-${n}`);
});

describe('API tokens', () => {
	it('creates a workspace-bound token, stores only its hash, and verifies it', async () => {
		const created = await createToken(auth(), {
			userId: 'user-1',
			tenantId: 'tenant-1',
			input
		});
		expect(created.secret).toMatch(/^flr_[A-Za-z]{64}$/);
		expect(created.token.start).toBe(created.secret.slice(0, 8));
		expect(created.token.scopes).toEqual(scopePresets.read);
		const expires = Date.parse(created.token.expiresAt ?? '') - Date.now();
		expect(Math.abs(expires - 90 * 86_400_000)).toBeLessThan(60_000);

		const row = await identity()
			.prepare('SELECT * FROM apikey WHERE id = ?')
			.bind(created.token.id)
			.first<Record<string, unknown>>();
		expect(JSON.stringify(row)).not.toContain(created.secret.slice(8));

		const verified = await verifyToken(auth(), identity(), created.secret);
		expect(verified).toEqual({
			status: 'valid',
			principal: {
				userId: 'user-1',
				tenantId: 'tenant-1',
				scopes: scopePresets.read,
				token: {
					id: created.token.id,
					name: 'CI',
					start: created.token.start,
					expiresAt: created.token.expiresAt
				}
			}
		});
		const [listed] = await listTokens(identity(), 'user-1', 'tenant-1', Date.now());
		expect(listed.id).toBe(created.token.id);
		expect(listed.lastUsedAt).not.toBeNull();
		expect(await verifyToken(auth(), identity(), `${created.secret.slice(0, -1)}x`)).toEqual({
			status: 'invalid'
		});
		expect(await verifyToken(auth(), identity(), 'not-a-token')).toEqual({ status: 'invalid' });
	});

	it('keeps tokens to their owner and stops a revoked token at once', async () => {
		const created = await createToken(auth(), { userId: 'user-2', tenantId: 'tenant-2', input });
		expect(await listTokens(identity(), 'user-3', 'tenant-3', Date.now())).toEqual([]);
		expect(await listTokens(identity(), 'user-2', 'tenant-3', Date.now())).toEqual([]);
		expect(await revokeToken(identity(), 'user-3', 'tenant-3', created.token.id)).toBe(false);
		expect((await verifyToken(auth(), identity(), created.secret)).status).toBe('valid');
		expect(await revokeToken(identity(), 'user-2', 'tenant-2', created.token.id)).toBe(true);
		expect(await verifyToken(auth(), identity(), created.secret)).toEqual({ status: 'invalid' });
	});

	it('refuses expired tokens and tokens whose user left the workspace', async () => {
		const expiring = await createToken(auth(), {
			userId: 'user-3',
			tenantId: 'tenant-3',
			input: { ...input, expiresInDays: 30 }
		});
		const lasting = await createToken(auth(), {
			userId: 'user-3',
			tenantId: 'tenant-3',
			input: { ...input, expiresInDays: null }
		});
		expect(lasting.token.expiresAt).toBeNull();
		await identity()
			.prepare('UPDATE apikey SET expiresAt = ? WHERE id = ?')
			.bind(Date.now() - 1000, expiring.token.id)
			.run();
		expect(await verifyToken(auth(), identity(), expiring.secret)).toEqual({ status: 'invalid' });
		expect(
			(await listTokens(identity(), 'user-3', 'tenant-3', Date.now())).map((t) => t.id)
		).toEqual([lasting.token.id]);
		expect(await deleteExpiredApiTokens(identity(), Date.now(), 100)).toBeGreaterThanOrEqual(0);

		await identity()
			.prepare('DELETE FROM tenant_memberships WHERE user_id = ?')
			.bind('user-3')
			.run();
		expect(await verifyToken(auth(), identity(), lasting.secret)).toEqual({ status: 'invalid' });
	});

	it('allows 25 tokens per user, also when creations race', async () => {
		const results = await Promise.allSettled(
			Array.from({ length: 30 }, (_, n) =>
				createToken(auth(), {
					userId: 'user-4',
					tenantId: 'tenant-4',
					input: { ...input, name: `Token ${n}` }
				})
			)
		);
		expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(25);
		for (const result of results)
			if (result.status === 'rejected') expect(result.reason).toBeInstanceOf(TokenLimitError);
		await expect(
			createToken(auth(), { userId: 'user-4', tenantId: 'tenant-4', input })
		).rejects.toBeInstanceOf(TokenLimitError);
	});

	it('allows 60 requests per minute per token across concurrent verifications', async () => {
		const created = await createToken(auth(), { userId: 'user-5', tenantId: 'tenant-5', input });
		const results = await Promise.all(
			Array.from({ length: 70 }, () => verifyToken(auth(), identity(), created.secret))
		);
		expect(results.filter((result) => result.status === 'valid')).toHaveLength(60);
		const limited = results.filter((result) => result.status === 'rate_limited');
		expect(limited).toHaveLength(10);
		for (const result of limited)
			if (result.status === 'rate_limited') {
				expect(result.retryAfterSeconds).toBeGreaterThan(0);
				expect(result.retryAfterSeconds).toBeLessThanOrEqual(60);
			}
	});

	it('deletes a user’s tokens with the user', async () => {
		const created = await createToken(auth(), { userId: 'user-6', tenantId: 'tenant-6', input });
		await identity()
			.prepare('DELETE FROM tenant_memberships WHERE user_id = ?')
			.bind('user-6')
			.run();
		await identity().prepare('DELETE FROM user WHERE id = ?').bind('user-6').run();
		const row = await identity()
			.prepare('SELECT id FROM apikey WHERE id = ?')
			.bind(created.token.id)
			.first();
		expect(row).toBeNull();
	});
});

describe('token API', () => {
	// Bearer tokens when the request has an Authorization header, else a test session for the
	// user in x-test-user that signed in at x-test-signed-in (default: now).
	function api() {
		const tokenAuth = auth();
		return createApi({
			identity: identity(),
			routing: env.TOKENS_ROUTING,
			analytics: { 'analytics-1': env.TOKENS_ANALYTICS },
			appOrigin: origin,
			tokenAuth,
			authenticate: async (request) => {
				if (request.headers.has('authorization'))
					return authenticateBearer(tokenAuth, identity(), request);
				const userId = request.headers.get('x-test-user');
				const signedInAt = request.headers.get('x-test-signed-in') ?? new Date().toISOString();
				return userId ? { kind: 'session', sessionId: 'session-test', userId, signedInAt } : null;
			}
		});
	}
	function call(method: string, path: string, headers: Record<string, string>, body?: unknown) {
		const init: RequestInit = { method, headers: { ...headers } };
		if (body !== undefined) {
			init.body = JSON.stringify(body);
			(init.headers as Record<string, string>)['content-type'] = 'application/json';
		}
		return api().fetch(new Request(`${origin}${path}`, init));
	}
	const bearer = (secret: string) => ({ authorization: `Bearer ${secret}` });
	const session = (user: string) => ({ 'x-test-user': user, origin });
	async function code(response: Response) {
		return ((await response.json()) as { error: { code: string } }).error.code;
	}
	async function issue(user: string, scopes: CreateTokenInput['scopes']) {
		const response = await call('POST', '/v1/tokens', session(user), {
			name: 'Test',
			scopes,
			expiresInDays: 30
		});
		expect(response.status).toBe(201);
		return ((await response.json()) as { secret: string; token: { id: string } }).secret;
	}

	it('allows each route only with its scope', async () => {
		const linksRead = await issue('user-7', ['links:read']);
		const reporting = await issue('user-7', ['analytics:read', 'usage:read']);
		const full = await issue('user-7', scopePresets.full);

		const created = await call(
			'POST',
			'/v1/links',
			{ ...bearer(full), 'idempotency-key': 'token-1' },
			{ destination: 'https://example.com/token' }
		);
		expect(created.status).toBe(201);
		const { link } = (await created.json()) as { link: { id: string } };

		const routes: [string, string, unknown?][] = [
			['GET', '/v1/links'],
			['GET', `/v1/links/${link.id}`],
			['POST', '/v1/links', { destination: 'https://example.com/x' }],
			['PATCH', `/v1/links/${link.id}`, { title: 'Changed' }],
			['GET', `/v1/links/${link.id}/analytics`],
			['GET', '/v1/usage']
		];
		const statuses = async (secret: string) => {
			const result = [];
			for (const [method, path, body] of routes)
				result.push(
					(
						await call(
							method,
							path,
							{ ...bearer(secret), 'idempotency-key': crypto.randomUUID() },
							body
						)
					).status
				);
			return result;
		};
		expect(await statuses(linksRead)).toEqual([200, 200, 403, 403, 403, 403]);
		expect(await statuses(reporting)).toEqual([403, 403, 403, 403, 200, 200]);
		const denied = await call('GET', '/v1/usage', bearer(linksRead));
		expect(await code(denied)).toBe('INSUFFICIENT_SCOPE');
	});

	it('keeps a token in its workspace and ignores cookies and sessions on it', async () => {
		const own = await issue('user-8', scopePresets.full);
		const created = await call(
			'POST',
			'/v1/links',
			{ ...session('user-8'), 'idempotency-key': 'session-1' },
			{ destination: 'https://example.com/eight' }
		);
		const { link } = (await created.json()) as { link: { id: string } };
		const other = await issue('user-9', scopePresets.full);
		expect((await call('GET', `/v1/links/${link.id}`, bearer(other))).status).toBe(404);
		expect((await call('GET', `/v1/links/${link.id}`, bearer(own))).status).toBe(200);
		// A bad token with a valid session header stays unauthenticated.
		const mixed = await call('GET', '/v1/links', { ...bearer('flr_wrong'), ...session('user-8') });
		expect(mixed.status).toBe(401);
		expect((await call('GET', '/v1/links', { authorization: 'Basic abc' })).status).toBe(401);
	});

	it('requires the origin for session writes and lets only sessions manage tokens', async () => {
		const noOrigin = await call(
			'POST',
			'/v1/tokens',
			{ 'x-test-user': 'user-8' },
			{ name: 'x', scopes: ['links:read'], expiresInDays: 30 }
		);
		expect(await code(noOrigin)).toBe('ORIGIN_REJECTED');
		const token = await issue('user-8', scopePresets.full);
		for (const [method, path] of [
			['GET', '/v1/tokens'],
			['POST', '/v1/tokens'],
			['DELETE', '/v1/tokens/anything']
		]) {
			const response = await call(
				method,
				path,
				bearer(token),
				method === 'POST' ? input : undefined
			);
			expect(response.status).toBe(403);
			expect(await code(response)).toBe('INSUFFICIENT_SCOPE');
		}
	});

	it('creates only after a recent sign-in, lists without secrets, and revokes', async () => {
		const stale = new Date(Date.now() - 11 * 60_000).toISOString();
		const late = await call(
			'POST',
			'/v1/tokens',
			{ ...session('user-9'), 'x-test-signed-in': stale },
			input
		);
		expect(await code(late)).toBe('REAUTH_REQUIRED');
		const page = (await (
			await call('GET', '/v1/tokens', { ...session('user-9'), 'x-test-signed-in': stale })
		).json()) as { freshUntil: string | null };
		expect(page.freshUntil).toBeNull();
		const invalid = await call('POST', '/v1/tokens', session('user-9'), { ...input, scopes: [] });
		expect(await code(invalid)).toBe('INVALID_INPUT');

		const secret = await issue('user-9', scopePresets.read);
		const listed = await call('GET', '/v1/tokens', session('user-9'));
		const text = await listed.text();
		expect(text).not.toContain(secret.slice(8));
		const { tokens } = JSON.parse(text) as { tokens: { id: string; start: string }[] };
		const token = tokens.find((item) => secret.startsWith(item.start));
		if (!token) throw new Error('Created token is not listed');

		expect((await call('DELETE', `/v1/tokens/${token.id}`, session('user-8'))).status).toBe(404);
		expect((await call('GET', '/v1/links', bearer(secret))).status).toBe(200);
		expect((await call('DELETE', `/v1/tokens/${token.id}`, session('user-9'))).status).toBe(204);
		expect((await call('GET', '/v1/links', bearer(secret))).status).toBe(401);
	});

	it("renames only the session's own workspace and validates the name", async () => {
		const read = async (user: string) =>
			(
				(await (await call('GET', '/v1/workspace', session(user))).json()) as {
					workspace: { name: string };
				}
			).workspace.name;
		expect(await read('user-4')).toBe('Workspace');
		const renamed = await call('PATCH', '/v1/workspace', session('user-4'), {
			name: '  Launch \t team  '
		});
		expect(renamed.status).toBe(200);
		expect(await read('user-4')).toBe('Launch team');
		expect(await read('user-5')).toBe('Workspace');

		for (const body of [
			{ name: '   ' },
			{ name: 'x'.repeat(61) },
			{ name: 'bell\u0007' },
			{ name: 42 },
			{ name: 'Fine', tenantId: 'tenant-5' }
		]) {
			const response = await call('PATCH', '/v1/workspace', session('user-4'), body);
			expect(response.status).toBe(422);
			expect(await code(response)).toBe('INVALID_INPUT');
		}
		expect(await read('user-4')).toBe('Launch team');
		expect(await read('user-5')).toBe('Workspace');

		const noOrigin = await call(
			'PATCH',
			'/v1/workspace',
			{ 'x-test-user': 'user-4' },
			{
				name: 'Other'
			}
		);
		expect(await code(noOrigin)).toBe('ORIGIN_REJECTED');
		// user-4 holds the maximum number of tokens, so another full-access token stands in.
		const token = await issue('user-7', scopePresets.full);
		for (const method of ['GET', 'PATCH']) {
			const response = await call(
				method,
				'/v1/workspace',
				bearer(token),
				method === 'PATCH' ? { name: 'Token' } : undefined
			);
			expect(response.status).toBe(403);
			expect(await code(response)).toBe('INSUFFICIENT_SCOPE');
		}
		expect(await read('user-4')).toBe('Launch team');
	});

	it('answers the 25th-token limit and the request limit with stable codes', async () => {
		for (let n = 0; n < 25; n += 1) await issue('user-1', ['links:read']).catch(() => undefined);
		const over = await call('POST', '/v1/tokens', session('user-1'), input);
		expect(over.status).toBe(403);
		expect(await code(over)).toBe('TOKEN_LIMIT_REACHED');

		const secret = await issue('user-9', ['usage:read']);
		const statuses = [];
		for (let n = 0; n < 61; n += 1)
			statuses.push((await call('GET', '/v1/usage', bearer(secret))).status);
		expect(statuses.filter((status) => status === 200)).toHaveLength(60);
		const limited = await call('GET', '/v1/usage', bearer(secret));
		expect(limited.status).toBe(429);
		expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
	});
});
