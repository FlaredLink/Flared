// SPDX-License-Identifier: AGPL-3.0-only
// Proves the pinned passkey plugin with the shared configuration under workerd and D1, using a
// software authenticator.
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
import { createSessionOptions } from '../packages/server/src/auth/options';
import { createPasskeyPlugin } from '../packages/server/src/auth/passkey';
import {
	AT,
	UP,
	UV,
	assertion,
	attestation,
	b64url,
	newAuthenticator,
	type Authenticator,
	type CeremonyChanges
} from './support/authenticator';

const origin = 'https://app.example';
const rpID = 'app.example';
const db = () => env.PASSKEY_IDENTITY;
const codes = new Map<string, string>();

async function auth() {
	const instance = betterAuth({
		...createSessionOptions(origin),
		secret: 'test-only-auth-secret-at-least-thirty-two-characters',
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

// --- cookies and ceremonies ------------------------------------------------------------------

function cookiesFrom(response: Response): string[] {
	return response.headers.getSetCookie().map((cookie) => cookie.split(';')[0]);
}
function request(cookies: string[]): Headers {
	return new Headers({ origin, cookie: cookies.join('; ') });
}

async function signIn(email: string): Promise<string[]> {
	await withIdentityProofScope('issue', async () =>
		(await auth()).api.sendVerificationOTP({
			body: { email, type: 'sign-in' },
			headers: new Headers({ origin })
		})
	);
	const otp = codes.get(email);
	if (!otp) throw new Error('Test delivery capture missing');
	const response = await withIdentityProofScope('verify', async () =>
		(await auth()).api.signInEmailOTP({
			body: { email, otp },
			headers: new Headers({ origin }),
			asResponse: true
		})
	);
	expect(response.status).toBe(200);
	return cookiesFrom(response);
}

async function registrationOptions(session: string[]) {
	const response = await withIdentityProofScope('issue', async () =>
		(await auth()).api.generatePasskeyRegistrationOptions({
			headers: request(session),
			query: { name: 'owner@example.com' },
			asResponse: true
		})
	);
	if (response.status !== 200) return { status: response.status, challenge: '', cookies: [] };
	const options = (await response.json()) as {
		challenge: string;
		rp: { id: string };
		authenticatorSelection: { residentKey: string; userVerification: string };
	};
	return { status: 200, options, challenge: options.challenge, cookies: cookiesFrom(response) };
}

async function register(session: string[], device: Authenticator, options: CeremonyChanges = {}) {
	const issued = await registrationOptions(session);
	if (issued.status !== 200) return issued.status;
	const response = await withIdentityProofScope('verify', async () =>
		(await auth()).api.verifyPasskeyRegistration({
			body: { response: await attestation(device, issued.challenge, options), name: 'Laptop' },
			headers: request([...session, ...issued.cookies]),
			asResponse: true
		})
	);
	return response.status;
}

async function authenticationOptions(session: string[] = []) {
	const response = await withIdentityProofScope('issue', async () =>
		(await auth()).api.generatePasskeyAuthenticationOptions({
			headers: request(session),
			asResponse: true
		})
	);
	expect(response.status).toBe(200);
	const options = (await response.json()) as { challenge: string };
	return { challenge: options.challenge, cookies: cookiesFrom(response) };
}

async function verifyAuthentication(
	cookies: string[],
	response: Awaited<ReturnType<typeof assertion>>
) {
	return withIdentityProofScope('verify', async () =>
		(await auth()).api.verifyPasskeyAuthentication({
			body: { response },
			headers: request(cookies),
			asResponse: true
		})
	);
}

async function passkeyRow(device: Authenticator) {
	return db()
		.prepare('SELECT id, userId, counter FROM passkey WHERE credentialID = ?')
		.bind(b64url(device.id))
		.first<{ id: string; userId: string; counter: number }>();
}
async function sessionCount(): Promise<number> {
	const row = await db().prepare('SELECT COUNT(*) AS n FROM session').first<{ n: number }>();
	return row?.n ?? -1;
}

let owner: string[];
let device: Authenticator;

beforeAll(async () => {
	await applyD1Migrations(db(), env.IDENTITY_MIGRATIONS, 'flared_core_migrations');
	owner = await signIn('owner@example.com');
	device = await newAuthenticator(origin);
});

describe('passkey registration', () => {
	it('asks for a discoverable credential with user verification on the configured host', async () => {
		const issued = await registrationOptions(owner);
		expect(issued.status).toBe(200);
		expect(issued.options?.rp.id).toBe(rpID);
		expect(issued.options?.authenticatorSelection).toMatchObject({
			residentKey: 'required',
			userVerification: 'required'
		});
	});

	it('needs a session that signed in within the last 10 minutes', async () => {
		expect(await registrationOptions([])).toMatchObject({ status: 401 });
		const stale = await signIn('stale@example.com');
		await db()
			.prepare(
				"UPDATE session SET createdAt = ? WHERE userId = (SELECT id FROM user WHERE email = 'stale@example.com')"
			)
			.bind(Date.now() - 601000)
			.run();
		expect(await registrationOptions(stale)).toMatchObject({ status: 403 });
	});

	// 1.7.6 wraps SimpleWebAuthn's origin and relying-party errors as 500; the user-verification
	// hook raises 400. Each stores nothing, and the facade reports them all the same way.
	it('refuses a wrong origin, a wrong relying party, and a missing user verification', async () => {
		const cases: [CeremonyChanges, number][] = [
			[{ from: 'https://evil.example' }, 500],
			[{ rp: 'evil.example' }, 500],
			[{ flags: UP | AT }, 400]
		];
		for (const [options, status] of cases) {
			const refused = await newAuthenticator(origin);
			expect(await register(owner, refused, options), JSON.stringify(options)).toBe(status);
			expect(await passkeyRow(refused)).toBeNull();
		}
	});

	it('stores a verified passkey for the signed-in user', async () => {
		expect(await register(owner, device)).toBe(200);
		const row = await passkeyRow(device);
		const user = await db()
			.prepare("SELECT id FROM user WHERE email = 'owner@example.com'")
			.first<{ id: string }>();
		expect(row?.userId).toBe(user?.id);
	});
});

describe('passkey sign-in', () => {
	it('creates a seven-day session', async () => {
		const issued = await authenticationOptions();
		const response = await verifyAuthentication(
			issued.cookies,
			await assertion(device, issued.challenge)
		);
		expect(response.status).toBe(200);
		const session = cookiesFrom(response).find((cookie) => cookie.includes('session_token='));
		expect(session).toBeDefined();
		const row = await db()
			.prepare('SELECT createdAt, expiresAt FROM session ORDER BY createdAt DESC LIMIT 1')
			.first<{ createdAt: number; expiresAt: number }>();
		expect((row?.expiresAt ?? 0) - (row?.createdAt ?? 0)).toBe(604800000);
	});

	it('accepts one of two concurrent uses of a challenge and rejects a replay', async () => {
		const issued = await authenticationOptions();
		const signed = await assertion(device, issued.challenge);
		const results = await Promise.all([
			verifyAuthentication(issued.cookies, signed),
			verifyAuthentication(issued.cookies, signed)
		]);
		expect(results.map((result) => result.status).sort()).toEqual([200, 400]);
		expect((await verifyAuthentication(issued.cookies, signed)).status).toBe(400);
		const fresh = await authenticationOptions();
		expect((await verifyAuthentication(fresh.cookies, signed)).status).toBe(400);
	});

	it('refuses a wrong origin, a wrong relying party, and a missing user verification', async () => {
		const before = await sessionCount();
		const counter = (await passkeyRow(device))?.counter;
		for (const options of [
			{ from: 'https://evil.example' },
			{ rp: 'evil.example' },
			{ flags: UP }
		]) {
			const issued = await authenticationOptions();
			const response = await verifyAuthentication(
				issued.cookies,
				await assertion(device, issued.challenge, options)
			);
			expect(response.status, JSON.stringify(options)).toBe(400);
			expect(cookiesFrom(response).some((cookie) => cookie.includes('session_token='))).toBe(false);
		}
		expect(await sessionCount()).toBe(before);
		expect((await passkeyRow(device))?.counter).toBe(counter);
	});
});

describe('passkey management', () => {
	it('keeps another user from renaming or deleting a passkey', async () => {
		const other = await signIn('other@example.com');
		const row = await passkeyRow(device);
		if (!row) throw new Error('Passkey missing');
		const instance = await auth();
		const rename = await instance.api.updatePasskey({
			body: { id: row.id, name: 'Taken' },
			headers: request(other),
			asResponse: true
		});
		const remove = await instance.api.deletePasskey({
			body: { id: row.id },
			headers: request(other),
			asResponse: true
		});
		expect(rename.status).toBe(401);
		expect(remove.status).toBe(401);
		expect(await passkeyRow(device)).not.toBeNull();
	});

	it('stops a deleted passkey from signing in at once', async () => {
		const row = await passkeyRow(device);
		if (!row) throw new Error('Passkey missing');
		const removed = await (
			await auth()
		).api.deletePasskey({ body: { id: row.id }, headers: request(owner), asResponse: true });
		expect(removed.status).toBe(200);
		const issued = await authenticationOptions();
		const response = await verifyAuthentication(
			issued.cookies,
			await assertion(device, issued.challenge)
		);
		expect(response.status).toBe(401);
	});
});
