// SPDX-License-Identifier: AGPL-3.0-only
// Proves the pinned passkey plugin with the shared configuration under workerd and D1, using a
// software authenticator: a P-256 key, "none" attestation, and hand-built authenticator data.
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

// --- encoding --------------------------------------------------------------------------------

function b64url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(value: string): Uint8Array {
	const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
	return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
	const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		result.set(part, offset);
		offset += part.length;
	}
	return result;
}
function cborHead(major: number, length: number): Uint8Array {
	if (length < 24) return Uint8Array.of((major << 5) | length);
	if (length < 256) return Uint8Array.of((major << 5) | 24, length);
	return Uint8Array.of((major << 5) | 25, length >> 8, length & 255);
}
type Cbor = number | string | Uint8Array | Map<Cbor, Cbor>;
function cbor(value: Cbor): Uint8Array {
	if (typeof value === 'number') return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
	if (typeof value === 'string') {
		const bytes = new TextEncoder().encode(value);
		return concat(cborHead(3, bytes.length), bytes);
	}
	if (value instanceof Uint8Array) return concat(cborHead(2, value.length), value);
	return concat(cborHead(5, value.size), ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)]));
}
async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}
// WebCrypto returns r || s; WebAuthn carries an ASN.1 DER signature.
function derSignature(raw: Uint8Array): Uint8Array {
	const integer = (bytes: Uint8Array) => {
		let start = 0;
		while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
		let value: Uint8Array<ArrayBuffer> = bytes.slice(start);
		if (value[0] & 0x80) value = concat(Uint8Array.of(0), value);
		return concat(Uint8Array.of(0x02, value.length), value);
	};
	const body = concat(integer(raw.slice(0, 32)), integer(raw.slice(32)));
	return concat(Uint8Array.of(0x30, body.length), body);
}

// --- software authenticator --------------------------------------------------------------------

const UP = 0x01;
const UV = 0x04;
const AT = 0x40;

interface Authenticator {
	id: Uint8Array;
	keys: CryptoKeyPair;
	counter: number;
}

async function newAuthenticator(): Promise<Authenticator> {
	const keys = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
		'sign',
		'verify'
	])) as CryptoKeyPair;
	return { id: crypto.getRandomValues(new Uint8Array(16)), keys, counter: 0 };
}

function clientData(type: string, challenge: string, from = origin): Uint8Array {
	return new TextEncoder().encode(
		JSON.stringify({ type, challenge, origin: from, crossOrigin: false })
	);
}

function counterBytes(counter: number): Uint8Array {
	return Uint8Array.of(
		counter >>> 24,
		(counter >>> 16) & 255,
		(counter >>> 8) & 255,
		counter & 255
	);
}

async function attestation(
	device: Authenticator,
	challenge: string,
	options: { flags?: number; rp?: string; from?: string } = {}
) {
	const jwk = await crypto.subtle.exportKey('jwk', device.keys.publicKey);
	if (jwk instanceof ArrayBuffer || !jwk.x || !jwk.y)
		throw new Error('Missing public key coordinates');
	const coseKey = cbor(
		new Map<Cbor, Cbor>([
			[1, 2],
			[3, -7],
			[-1, 1],
			[-2, fromB64url(jwk.x)],
			[-3, fromB64url(jwk.y)]
		])
	);
	const authData = concat(
		await sha256(new TextEncoder().encode(options.rp ?? rpID)),
		Uint8Array.of(options.flags ?? UP | UV | AT),
		counterBytes(device.counter),
		new Uint8Array(16),
		Uint8Array.of(device.id.length >> 8, device.id.length & 255),
		device.id,
		coseKey
	);
	const attestationObject = cbor(
		new Map<Cbor, Cbor>([
			['fmt', 'none'],
			['attStmt', new Map()],
			['authData', authData]
		])
	);
	return {
		id: b64url(device.id),
		rawId: b64url(device.id),
		type: 'public-key' as const,
		authenticatorAttachment: 'platform' as const,
		clientExtensionResults: {},
		response: {
			clientDataJSON: b64url(clientData('webauthn.create', challenge, options.from)),
			attestationObject: b64url(attestationObject),
			transports: ['internal']
		}
	};
}

async function assertion(
	device: Authenticator,
	challenge: string,
	options: { flags?: number; rp?: string; from?: string } = {}
) {
	device.counter += 1;
	const authData = concat(
		await sha256(new TextEncoder().encode(options.rp ?? rpID)),
		Uint8Array.of(options.flags ?? UP | UV),
		counterBytes(device.counter)
	);
	const data = clientData('webauthn.get', challenge, options.from);
	const signed = concat(authData, await sha256(data));
	const raw = new Uint8Array(
		await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, device.keys.privateKey, signed)
	);
	return {
		id: b64url(device.id),
		rawId: b64url(device.id),
		type: 'public-key' as const,
		authenticatorAttachment: 'platform' as const,
		clientExtensionResults: {},
		response: {
			clientDataJSON: b64url(data),
			authenticatorData: b64url(authData),
			signature: b64url(derSignature(raw))
		}
	};
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

async function register(
	session: string[],
	device: Authenticator,
	options: { flags?: number; rp?: string; from?: string } = {}
) {
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
	device = await newAuthenticator();
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
		const cases: [{ flags?: number; rp?: string; from?: string }, number][] = [
			[{ from: 'https://evil.example' }, 500],
			[{ rp: 'evil.example' }, 500],
			[{ flags: UP | AT }, 400]
		];
		for (const [options, status] of cases) {
			const refused = await newAuthenticator();
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
