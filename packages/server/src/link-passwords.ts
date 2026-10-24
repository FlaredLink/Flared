// SPDX-License-Identifier: AGPL-3.0-only
// Link passwords: a keyed hash. HMAC-SHA256 with the installation's link password key, then
// PBKDF2-SHA256 with a random salt. Without the key, a stored hash cannot be tested, so a short
// PBKDF2 keeps each check within the CPU time of Workers Free. The key comes from a deployment
// secret, never from the database, and its ID is in each hash, so a hash made with another key
// is told apart from a wrong password. The stored form is
// hmac-pbkdf2-sha256$<iterations>$<key ID, 16 hex>$<16-byte salt, hex>$<32-byte key, hex>.

export const linkPasswordIterations = 5000;
const saltBytes = 16;
const keyBits = 256;
// Secrets shorter than this are refused, so a weak setting fails at the boundary.
export const minLinkPasswordSecretLength = 32;

const storedPattern =
	/^hmac-pbkdf2-sha256\$(\d{1,7})\$([0-9a-f]{16})\$([0-9a-f]{32})\$([0-9a-f]{64})$/;

// match: the password is right. mismatch: it is wrong. other-key: the hash was made with another
// key, so no password can match; the installation's key changed.
export type LinkPasswordCheck = 'match' | 'mismatch' | 'other-key';

export interface LinkPasswords {
	hash(password: string): Promise<string>;
	verify(password: string, stored: string): Promise<LinkPasswordCheck>;
}

const encoder = new TextEncoder();

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function fromHex(value: string): Uint8Array<ArrayBuffer> {
	return Uint8Array.from(value.match(/../g) ?? [], (pair) => parseInt(pair, 16));
}

// Compares every byte, so the time does not show where two values differ.
function equal(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let difference = 0;
	for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
	return difference === 0;
}

export function isLinkPasswordHash(value: string): boolean {
	return storedPattern.test(value);
}

// info separates this key from every other key derived from the same secret. The key is derived
// at the first use, so a Worker can compose this without awaiting it.
export function createLinkPasswords(
	secret: string,
	info = 'flared:link-password:v1'
): LinkPasswords {
	if (secret.length < minLinkPasswordSecretLength)
		throw new Error(
			`The link password secret needs at least ${minLinkPasswordSecretLength} characters`
		);
	let derived: Promise<{ key: CryptoKey; keyId: string }> | undefined;
	const keys = () => (derived ??= deriveKey(secret, info));

	// Normalized, so one password typed two Unicode ways still matches.
	async function derive(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number) {
		const { key } = await keys();
		const keyed = await crypto.subtle.sign('HMAC', key, encoder.encode(password.normalize('NFKC')));
		const base = await crypto.subtle.importKey('raw', keyed, 'PBKDF2', false, ['deriveBits']);
		return new Uint8Array(
			await crypto.subtle.deriveBits(
				{ name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
				base,
				keyBits
			)
		);
	}

	return {
		async hash(password) {
			const { keyId } = await keys();
			const salt = crypto.getRandomValues(new Uint8Array(saltBytes));
			const value = await derive(password, salt, linkPasswordIterations);
			return `hmac-pbkdf2-sha256$${linkPasswordIterations}$${keyId}$${hex(salt)}$${hex(value)}`;
		},
		async verify(password, stored) {
			const match = storedPattern.exec(stored);
			if (!match) throw new Error('Invalid stored link password');
			const [, iterations, id, salt, expected] = match;
			if (id !== (await keys()).keyId) return 'other-key';
			// A later version may change the count; a stored count above Workers' limit is damage.
			const count = Number(iterations);
			if (count < 1 || count > 100000) throw new Error('Invalid stored link password');
			const value = await derive(password, fromHex(salt), count);
			return equal(value, fromHex(expected)) ? 'match' : 'mismatch';
		}
	};
}

// HKDF-SHA256 of the secret gives the HMAC key; its ID is the first 8 bytes of an HMAC of a
// fixed label, so the ID shows which key made a hash and reveals nothing about the key.
async function deriveKey(secret: string, info: string): Promise<{ key: CryptoKey; keyId: string }> {
	const material = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, [
		'deriveBits'
	]);
	const bits = await crypto.subtle.deriveBits(
		{ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: encoder.encode(info) },
		material,
		256
	);
	const key = await crypto.subtle.importKey('raw', bits, { name: 'HMAC', hash: 'SHA-256' }, false, [
		'sign'
	]);
	const label = await crypto.subtle.sign('HMAC', key, encoder.encode('flared:key-id'));
	return { key, keyId: hex(new Uint8Array(label).slice(0, 8)) };
}
