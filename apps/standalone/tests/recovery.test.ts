// SPDX-License-Identifier: AGPL-3.0-only
// The operator password reset SQL against real D1: every credential of the owner ends, the new
// password works and the old one does not, setup stays closed, and links stay as they were.
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { hashPassword, passwordHashPattern } from '@flared/server/auth/password';
import { readSetupState } from '@flared/data/setup';
import { createOwnerAuthRoutes } from '@flared/server/auth/owner';
import { handleSetup } from '@flared/server/setup';
import { resetPasswordSql } from '../scripts/reset-sql';

const origin = 'https://flared.example.workers.dev';
const config = {
	origin,
	secret: 'test-only-auth-secret-at-least-thirty-two-characters',
	rateLimitSecret: 'test-only-rate-limit-secret-at-least-32-characters'
};
const identity = () => env.RECOVERY_IDENTITY;

async function count(table: string): Promise<number> {
	return (
		(await identity().prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())?.n ?? -1
	);
}

let source = 0;
async function signIn(password: string): Promise<number> {
	source += 1;
	const response = await createOwnerAuthRoutes({ db: identity(), config }).fetch(
		new Request(`${origin}/api/auth/sign-in/password`, {
			method: 'POST',
			headers: {
				origin,
				'content-type': 'application/json',
				'x-flared-source': `198.51.100.${source}`
			},
			body: JSON.stringify({ username: 'owner', password })
		})
	);
	return response.status;
}

let userId = '';

beforeAll(async () => {
	await applyD1Migrations(identity(), env.IDENTITY_MIGRATIONS);
	await applyD1Migrations(env.RECOVERY_ROUTING, env.ROUTING_MIGRATIONS);
	await applyD1Migrations(env.RECOVERY_ANALYTICS, env.ANALYTICS_MIGRATIONS);
	const response = await handleSetup(
		new Request(`${origin}/api/setup`, {
			method: 'POST',
			headers: { origin, 'content-type': 'application/json', 'x-flared-source': '198.51.100.1' },
			body: JSON.stringify({
				secret: 'test-only-setup-secret-with-at-least-32-bytes',
				username: 'owner',
				password: 'the forgotten password',
				workspaceName: 'Links'
			})
		}),
		{
			identity: identity(),
			routing: env.RECOVERY_ROUTING,
			analytics: { 'analytics-1': env.RECOVERY_ANALYTICS },
			analyticsShardId: 'analytics-1',
			config,
			setupSecret: 'test-only-setup-secret-with-at-least-32-bytes',
			limits: { activeLinkLimit: 10, monthlyClickLimit: 10, retentionDays: 30, domainLimit: 1 }
		}
	);
	expect(response.status).toBe(200);
	userId = (await identity().prepare('SELECT id FROM "user"').first<{ id: string }>())?.id ?? '';
});

describe('owner password reset', () => {
	it('builds SQL only from checked values', () => {
		const valid = {
			userId,
			passwordHash: `pbkdf2-sha256$100000$${'a'.repeat(32)}$${'b'.repeat(64)}`,
			auditId: crypto.randomUUID(),
			now: 1
		};
		expect(() => resetPasswordSql(valid)).not.toThrow();
		for (const change of [
			{ userId: "x'; DROP TABLE account; --" },
			{ passwordHash: "abc'; --" },
			{ auditId: 'not-a-uuid' },
			{ now: -1 }
		])
			expect(() => resetPasswordSql({ ...valid, ...change })).toThrow();
	});

	it('ends every credential, sets the new password, and leaves setup and links alone', async () => {
		const now = Date.now();
		const links = await env.RECOVERY_ROUTING.prepare('SELECT COUNT(*) AS n FROM domains').first<{
			n: number;
		}>();
		await identity().batch([
			identity()
				.prepare(
					'INSERT INTO apikey (id, referenceId, key, createdAt, updatedAt) VALUES (?, ?, ?, 0, 0)'
				)
				.bind('key-1', userId, 'hash'),
			identity().prepare(
				"INSERT INTO oauthClient (id, clientId, redirectUris) VALUES ('client', 'client', '[]')"
			),
			identity()
				.prepare(
					"INSERT INTO oauthConsent (id, clientId, userId, scopes) VALUES ('consent', 'client', ?, '[]')"
				)
				.bind(userId),
			identity()
				.prepare(
					"INSERT INTO oauthAccessToken (id, token, clientId, userId, scopes) VALUES ('access', 'token', 'client', ?, '[]')"
				)
				.bind(userId),
			identity()
				.prepare(
					"INSERT INTO passkey (id, publicKey, userId, credentialID, counter, deviceType, backedUp) VALUES ('passkey', 'key', ?, 'credential', 0, 'singleDevice', 0)"
				)
				.bind(userId),
			identity()
				.prepare(
					"INSERT INTO verification (id, identifier, value, expiresAt, createdAt, updatedAt) VALUES ('code', 'oauth-code', 'value', ?, 0, 0)"
				)
				.bind(now + 60000)
		]);
		// A sign-in with the old password while the reset runs.
		expect(await signIn('the forgotten password')).toBe(200);
		expect(await count('session')).toBeGreaterThan(0);

		const passwordHash = await hashPassword('the new long password');
		expect(passwordHash).toMatch(passwordHashPattern);
		await identity().exec(
			resetPasswordSql({ userId, passwordHash, auditId: crypto.randomUUID(), now }).replace(
				/\n/g,
				' '
			)
		);
		for (const table of [
			'session',
			'apikey',
			'oauthAccessToken',
			'oauthConsent',
			'passkey',
			'verification'
		])
			expect(await count(table), table).toBe(0);
		expect(await count("owner_audit WHERE action = 'password_reset'")).toBe(1);
		expect(await signIn('the forgotten password')).toBe(401);
		expect(await signIn('the new long password')).toBe(200);
		expect(await readSetupState(identity())).toBe('active');
		const after = await env.RECOVERY_ROUTING.prepare('SELECT COUNT(*) AS n FROM domains').first<{
			n: number;
		}>();
		expect(after?.n).toBe(links?.n);
	});
});
