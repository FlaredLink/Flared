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
	for (const n of [1, 2, 3, 4, 5, 6]) await addTenant(`user-${n}`, `tenant-${n}`);
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
			principal: { userId: 'user-1', tenantId: 'tenant-1', scopes: scopePresets.read }
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
