// SPDX-License-Identifier: AGPL-3.0-only
// A software WebAuthn authenticator for tests: a P-256 key, "none" attestation, and hand-built
// authenticator data. It never leaves the test runtime.

// --- encoding --------------------------------------------------------------------------------

export function b64url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function fromB64url(value: string): Uint8Array {
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

export const UP = 0x01;
export const UV = 0x04;
export const AT = 0x40;

export interface Authenticator {
	origin: string;
	rpID: string;
	id: Uint8Array;
	keys: CryptoKeyPair;
	counter: number;
}

export interface CeremonyChanges {
	flags?: number;
	rp?: string;
	from?: string;
}

// The authenticator belongs to one app origin; its host is the relying party.
export async function newAuthenticator(origin: string): Promise<Authenticator> {
	const keys = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
		'sign',
		'verify'
	])) as CryptoKeyPair;
	return {
		origin,
		rpID: new URL(origin).hostname,
		id: crypto.getRandomValues(new Uint8Array(16)),
		keys,
		counter: 0
	};
}

function clientData(type: string, challenge: string, from: string): Uint8Array {
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

export async function attestation(
	device: Authenticator,
	challenge: string,
	options: CeremonyChanges = {}
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
		await sha256(new TextEncoder().encode(options.rp ?? device.rpID)),
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
			clientDataJSON: b64url(
				clientData('webauthn.create', challenge, options.from ?? device.origin)
			),
			attestationObject: b64url(attestationObject),
			transports: ['internal']
		}
	};
}

export async function assertion(
	device: Authenticator,
	challenge: string,
	options: CeremonyChanges = {}
) {
	device.counter += 1;
	const authData = concat(
		await sha256(new TextEncoder().encode(options.rp ?? device.rpID)),
		Uint8Array.of(options.flags ?? UP | UV),
		counterBytes(device.counter)
	);
	const data = clientData('webauthn.get', challenge, options.from ?? device.origin);
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
