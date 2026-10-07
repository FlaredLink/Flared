// SPDX-License-Identifier: AGPL-3.0-only
import { env } from 'cloudflare:workers';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { betterAuth } from 'better-auth';
import { emailOTP, magicLink } from 'better-auth/plugins';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '../packages/data/src/identity';
import * as baselineSchema from './schema';
import { createIdentityAdapter } from '../packages/data/src/identity-adapter';
import migration from '../packages/data/migrations/identity/0001_auth.sql?raw';
import sql from './schema.sql?raw';
import {
	installD1ProofGuards,
	withIdentityProofScope
} from '../packages/data/src/identity-proof-guards';

declare global {
	namespace Cloudflare {
		interface Env {
			IDENTITY: D1Database;
			PROBE_BASELINE: boolean;
		}
	}
}
const origin = 'https://flared.link';
const guardedTest = it.skipIf(env.PROBE_BASELINE);
const headers = new Headers({ origin });
const captured = new Map<string, string>();
const links = new Map<string, string>();
async function auth() {
	const selectedSchema = env.PROBE_BASELINE ? baselineSchema : schema;
	const instance = betterAuth({
		baseURL: origin,
		secret: 'test-only-auth-secret-at-least-thirty-two-characters',
		database: env.PROBE_BASELINE
			? drizzleAdapter(drizzle(env.IDENTITY, { schema: selectedSchema }), {
					provider: 'sqlite',
					schema: selectedSchema,
					transaction: false
				})
			: createIdentityAdapter(env.IDENTITY),
		verification: { disableCleanup: true },
		rateLimit: { enabled: false },
		logger: { disabled: true },
		advanced: { ipAddress: { disableIpTracking: true } },
		session: { expiresIn: 604800, disableSessionRefresh: true, cookieCache: { enabled: false } },
		plugins: [
			emailOTP({
				expiresIn: 300,
				allowedAttempts: 3,
				storeOTP: 'hashed',
				async sendVerificationOTP({ email, otp }) {
					captured.set(email, otp);
				}
			}),
			magicLink({
				expiresIn: 300,
				storeToken: 'hashed',
				async sendMagicLink({ email, token }) {
					links.set(email, token);
				}
			})
		]
	});
	if (!env.PROBE_BASELINE) installD1ProofGuards(await instance.$context, env.IDENTITY);
	return instance;
}
async function issue(email: string) {
	await withIdentityProofScope('issue', async () =>
		(await auth()).api.sendVerificationOTP({ body: { email, type: 'sign-in' }, headers })
	);
	const code = captured.get(email);
	if (!code) throw new Error('Test delivery capture missing');
	return code;
}
function verify(email: string, otp: string) {
	return withIdentityProofScope('verify', async () =>
		(await auth()).api.signInEmailOTP({ body: { email, otp }, headers, asResponse: true })
	);
}
function verifyLink(token: string) {
	return withIdentityProofScope('verify', async () =>
		(await auth()).api.magicLinkVerify({
			query: {
				token,
				callbackURL: '/app',
				newUserCallbackURL: '/app',
				errorCallbackURL: '/app/login'
			},
			headers,
			asResponse: true
		})
	);
}
async function count(table: 'session' | 'user' | 'verification') {
	return (
		await env.IDENTITY.prepare(`SELECT COUNT(*) AS total FROM "${table}"`).first<{
			total: number;
		}>()
	)?.total;
}
function barrier() {
	let entered!: () => void;
	let release!: () => void;
	const reached = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const resume = new Promise<void>((resolve) => {
		release = resolve;
	});
	return {
		reached,
		release,
		async pause() {
			entered();
			await resume;
		}
	};
}

beforeEach(async () => {
	vi.useRealTimers();
	captured.clear();
	links.clear();
	await env.IDENTITY.exec(
		'DROP TABLE IF EXISTS session; DROP TABLE IF EXISTS account; DROP TABLE IF EXISTS verification; DROP TABLE IF EXISTS user;'
	);
	await env.IDENTITY.exec((env.PROBE_BASELINE ? sql : migration).replace(/^--.*$/gm, ''));
	// The shared Drizzle schema also maps the user columns that migration 0011 adds.
	if (!env.PROBE_BASELINE)
		await env.IDENTITY.exec(
			'ALTER TABLE user ADD COLUMN username TEXT; ALTER TABLE user ADD COLUMN displayUsername TEXT;'
		);
});
afterEach(() => vi.useRealTimers());

describe('pinned Better Auth 1.7.7 on real Workers/D1, transactions disabled', () => {
	it('allows exactly one session from 20 parallel OTP redemptions, then rejects replay', async () => {
		for (let round = 0; round < 3; round++) {
			const email = `otp-${round}@example.com`;
			const code = await issue(email);
			const responses = await Promise.all(Array.from({ length: 20 }, () => verify(email, code)));
			expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
			expect(await count('session')).toBe(round + 1);
			expect((await verify(email, code)).status).toBeGreaterThanOrEqual(400);
		}
	});
	it('allows exactly one session from 20 parallel magic-link redemptions, then rejects replay', async () => {
		for (let round = 0; round < 3; round++) {
			const email = `magic-${round}@example.com`;
			await withIdentityProofScope('issue', async () =>
				(await auth()).api.signInMagicLink({ body: { email }, headers })
			);
			const token = links.get(email);
			if (!token) throw new Error('Test token missing');
			const responses = await Promise.all(Array.from({ length: 20 }, () => verifyLink(token)));
			expect(
				responses.filter(
					(response) => response.headers.get('location') === 'https://flared.link/app'
				)
			).toHaveLength(1);
			expect(await count('session')).toBe(round + 1);
			expect((await verifyLink(token)).headers.get('location')).toContain('/app/login?error=');
		}
	});
	it('locks the code after three sequential mismatches', async () => {
		const email = 'wrong@example.com';
		const code = await issue(email);
		const wrong = code === '000000' ? '111111' : '000000';
		for (let i = 0; i < 3; i++)
			expect((await verify(email, wrong)).status).toBeGreaterThanOrEqual(400);
		expect((await verify(email, code)).status).toBeGreaterThanOrEqual(400);
		expect(await count('session')).toBe(0);
	});
	it('never resets the failure budget during overlapping mismatch batches', async () => {
		const email = 'parallel-wrong@example.com';
		const code = await issue(email);
		const wrong = code === '000000' ? '111111' : '000000';
		for (let batch = 0; batch < 3; batch++) {
			const responses = await Promise.all(Array.from({ length: 20 }, () => verify(email, wrong)));
			expect(responses.every((response) => response.status >= 400)).toBe(true);
			const rows = await env.IDENTITY.prepare('SELECT value FROM verification').all<{
				value: string;
			}>();
			if (rows.results.length)
				expect(
					Math.max(...rows.results.map((row) => Number(row.value.split(':').at(-1))))
				).toBeGreaterThanOrEqual(batch + 1);
		}
		expect((await verify(email, code)).status).toBeGreaterThanOrEqual(400);
		expect(await count('session')).toBe(0);
	});
	it('a sequential resend makes the old code unusable', async () => {
		const email = 'resend@example.com';
		const old = await issue(email);
		await new Promise((resolve) => setTimeout(resolve, 2));
		let current = await issue(email);
		while (current === old) current = await issue(email);
		expect((await verify(email, old)).status).toBeGreaterThanOrEqual(400);
		expect((await verify(email, current)).status).toBe(200);
	});
	it('wrong-code recreation cannot overwrite a newer resend or restore the old proof', async () => {
		const email = 'race@example.com';
		const old = await issue(email);
		const instance = await auth();
		const context = await instance.$context;
		const gate = barrier();
		const create = context.internalAdapter.createVerificationValue.bind(context.internalAdapter);
		context.internalAdapter.createVerificationValue = async (data) => {
			await gate.pause();
			return create(data);
		};
		const pending = withIdentityProofScope('verify', () =>
			instance.api.signInEmailOTP({
				body: { email, otp: old === '000000' ? '111111' : '000000' },
				headers,
				asResponse: true
			})
		);
		await gate.reached;
		let current = await issue(email);
		while (current === old) current = await issue(email);
		gate.release();
		await pending;
		const rows = await env.IDENTITY.prepare('SELECT id FROM verification').all();
		expect((await verify(email, old)).status).toBeGreaterThanOrEqual(400);
		expect(rows.results).toHaveLength(1);
		expect((await verify(email, current)).status).toBe(200);
	});
	it('expiry cleanup cannot delete a newer resend', async () => {
		const email = 'expiry-race@example.com';
		await issue(email);
		await env.IDENTITY.prepare('UPDATE verification SET expiresAt = ?')
			.bind(Date.now() - 1000)
			.run();
		const instance = await auth();
		const context = await instance.$context;
		const gate = barrier();
		const remove = context.internalAdapter.deleteVerificationByIdentifier.bind(
			context.internalAdapter
		);
		context.internalAdapter.deleteVerificationByIdentifier = async (identifier) => {
			await gate.pause();
			return remove(identifier);
		};
		const pending = withIdentityProofScope('verify', () =>
			instance.api.signInEmailOTP({ body: { email, otp: '000000' }, headers, asResponse: true })
		);
		await gate.reached;
		const current = await issue(email);
		gate.release();
		await pending;
		expect((await verify(email, current)).status).toBe(200);
	});
	it('rejects a proof exactly at its expiry', async () => {
		const email = 'exact-expiry@example.com';
		const code = await issue(email);
		const record = await env.IDENTITY.prepare('SELECT expiresAt FROM verification').first<{
			expiresAt: number;
		}>();
		if (!record) throw new Error('Missing record');
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(record.expiresAt);
		expect((await verify(email, code)).status).toBeGreaterThanOrEqual(400);
		expect(await count('session')).toBe(0);
	});
	it('isolates 20 concurrent verification scopes sharing one auth instance', async () => {
		const email = 'shared-instance@example.com';
		const code = await issue(email);
		const instance = await auth();
		const responses = await Promise.all(
			Array.from({ length: 20 }, () =>
				withIdentityProofScope('verify', () =>
					instance.api.signInEmailOTP({ body: { email, otp: code }, headers, asResponse: true })
				)
			)
		);
		expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
		expect(await count('session')).toBe(1);
	});
	guardedTest('refuses unscoped proof mutation before creating a challenge', async () => {
		const instance = await auth();
		await expect(
			instance.api.sendVerificationOTP({
				body: { email: 'unscoped@example.com', type: 'sign-in' },
				headers
			})
		).rejects.toThrow('explicit scope');
		expect(await count('verification')).toBe(0);
		expect(await count('user')).toBe(0);
	});
	guardedTest('does not let one invocation restore the same claim twice', async () => {
		const email = 'restore-once@example.com';
		await issue(email);
		const instance = await auth();
		const context = await instance.$context;
		await withIdentityProofScope('verify', async () => {
			const original = await context.internalAdapter.consumeVerificationValue(
				`sign-in-otp-${email}`
			);
			if (!original) throw new Error('Missing claimed proof');
			const hash = original.value.slice(0, original.value.lastIndexOf(':'));
			const data = {
				identifier: original.identifier,
				value: `${hash}:1`,
				expiresAt: original.expiresAt
			};
			await context.internalAdapter.createVerificationValue(data);
			await expect(context.internalAdapter.createVerificationValue(data)).rejects.toThrow(
				'claimed generation'
			);
			const row = await env.IDENTITY.prepare(
				'SELECT value, consumed FROM verification WHERE identifier=?'
			)
				.bind(original.identifier)
				.first<{ value: string; consumed: number }>();
			expect(row?.value).toBe(`${hash}:1`);
			expect(row?.consumed).toBe(0);
		});
	});
	guardedTest('cannot restore an altered hash or expiry in a verification scope', async () => {
		const email = 'restore-data@example.com';
		await issue(email);
		const context = await (await auth()).$context;
		await withIdentityProofScope('verify', async () => {
			const original = await context.internalAdapter.consumeVerificationValue(
				`sign-in-otp-${email}`
			);
			if (!original) throw new Error('Missing claimed proof');
			await expect(
				context.internalAdapter.createVerificationValue({
					identifier: original.identifier,
					value: 'different-hash:1',
					expiresAt: original.expiresAt
				})
			).rejects.toThrow('claimed generation');
			await expect(
				context.internalAdapter.createVerificationValue({
					identifier: original.identifier,
					value: original.value,
					expiresAt: new Date(original.expiresAt.getTime() + 1000)
				})
			).rejects.toThrow('claimed generation');
			const row = await env.IDENTITY.prepare('SELECT consumed FROM verification WHERE identifier=?')
				.bind(original.identifier)
				.first<{ consumed: number }>();
			expect(row?.consumed).toBe(1);
		});
	});
	guardedTest(
		'uses fresh storage generations even when library ID generation repeats',
		async () => {
			const context = await (await auth()).$context;
			context.generateId = () => 'repeated-storage-id';
			const data = {
				identifier: 'generation-probe',
				value: 'stored-hash:0',
				expiresAt: new Date(Date.now() + 300000)
			};
			const first = await withIdentityProofScope('issue', () =>
				context.internalAdapter.createVerificationValue(data)
			);
			const second = await withIdentityProofScope('issue', () =>
				context.internalAdapter.createVerificationValue(data)
			);
			expect(second.id).not.toBe(first.id);
		}
	);
	guardedTest('cannot restore a wrong-attempt claim exactly at expiry', async () => {
		const email = 'restore-expiry@example.com';
		await issue(email);
		const context = await (await auth()).$context;
		await withIdentityProofScope('verify', async () => {
			const original = await context.internalAdapter.consumeVerificationValue(
				`sign-in-otp-${email}`
			);
			if (!original) throw new Error('Missing claimed proof');
			vi.useFakeTimers({ toFake: ['Date'] });
			vi.setSystemTime(original.expiresAt);
			const hash = original.value.slice(0, original.value.lastIndexOf(':'));
			await expect(
				context.internalAdapter.createVerificationValue({
					identifier: original.identifier,
					value: `${hash}:1`,
					expiresAt: original.expiresAt
				})
			).rejects.toThrow('Invalid or expired proof');
			const row = await env.IDENTITY.prepare('SELECT consumed FROM verification WHERE identifier=?')
				.bind(original.identifier)
				.first<{ consumed: number }>();
			expect(row?.consumed).toBe(1);
		});
	});
	guardedTest(
		'uses SQLite execution time to reject a proof when the bound JS clock is stale',
		async () => {
			const email = 'sql-clock@example.com';
			const code = await issue(email);
			const earlier = Date.now();
			await env.IDENTITY.prepare('UPDATE verification SET expiresAt=?')
				.bind(earlier + 100)
				.run();
			vi.useFakeTimers({ toFake: ['Date'] });
			vi.setSystemTime(earlier);
			await new Promise((resolve) => setTimeout(resolve, 150));
			expect((await verify(email, code)).status).toBeGreaterThanOrEqual(400);
			expect(await count('session')).toBe(0);
		}
	);
	it('exposes only fixed magic-link redirects, with secure cookies on success and none on failure', async () => {
		await withIdentityProofScope('issue', async () =>
			(await auth()).api.signInMagicLink({ body: { email: 'cookies@example.com' }, headers })
		);
		const token = links.get('cookies@example.com');
		if (!token) throw new Error('Missing token');
		const success = await verifyLink(token);
		expect(success.status).toBe(302);
		expect(success.headers.get('location')).toBe('https://flared.link/app');
		expect(success.headers.getSetCookie().join(';')).toMatch(/HttpOnly/);
		expect(success.headers.getSetCookie().join(';')).toMatch(/Secure/);
		expect(success.headers.getSetCookie().join(';')).toMatch(/SameSite=Lax/i);
		const failure = await verifyLink(token);
		expect(failure.headers.get('location')).toContain('https://flared.link/app/login?error=');
		expect(failure.headers.getSetCookie()).toHaveLength(0);
	});
});
