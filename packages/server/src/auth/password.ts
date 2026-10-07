// SPDX-License-Identifier: AGPL-3.0-only
// The owner's password hash: PBKDF2-SHA256 through Web Crypto. It runs natively in the Worker,
// so one hash fits the CPU limit of Workers Free; Better Auth's default scrypt takes about 50 ms.
// 100,000 iterations is the most Workers accepts. The stored form is
// pbkdf2-sha256$<iterations>$<16-byte salt, hex>$<32-byte key, hex>.
const iterations = 100000;
const saltBytes = 16;
const keyBits = 256;

export const passwordHashPattern = /^pbkdf2-sha256\$100000\$[0-9a-f]{32}\$[0-9a-f]{64}$/;

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function fromHex(value: string): Uint8Array {
	return Uint8Array.from(value.match(/../g) ?? [], (pair) => parseInt(pair, 16));
}

// Normalized like Better Auth's own hash, so one password typed two Unicode ways still matches.
async function derive(password: string, salt: Uint8Array): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(password.normalize('NFKC')),
		'PBKDF2',
		false,
		['deriveBits']
	);
	const bits = await crypto.subtle.deriveBits(
		{ name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
		key,
		keyBits
	);
	return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
	const salt = crypto.getRandomValues(new Uint8Array(saltBytes));
	return `pbkdf2-sha256$${iterations}$${hex(salt)}$${hex(await derive(password, salt))}`;
}

// A stored value of any other form never matches.
export async function verifyPassword(input: { hash: string; password: string }): Promise<boolean> {
	if (!passwordHashPattern.test(input.hash)) return false;
	const [, , salt, expected] = input.hash.split('$');
	if (salt === undefined || expected === undefined) return false;
	const derived = await derive(input.password, fromHex(salt));
	return crypto.subtle.timingSafeEqual(derived, fromHex(expected));
}
