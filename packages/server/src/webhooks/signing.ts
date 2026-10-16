// SPDX-License-Identifier: AGPL-3.0-only
// Webhook signing secrets and signatures (Standard Webhooks). No secret is stored: each one is
// derived from the deployment secret, the endpoint ID, and the endpoint's secret version, so a
// rotation is a new version. A new deployment secret changes every endpoint secret; key_id
// tells which deployment secret an endpoint's secret came from.
import { keyedHash } from '../auth/limits';

const secretPrefix = 'whsec_';

async function hmac(key: Uint8Array<ArrayBuffer>, message: string): Promise<Uint8Array> {
	const imported = await crypto.subtle.importKey(
		'raw',
		key,
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	return new Uint8Array(
		await crypto.subtle.sign('HMAC', imported, new TextEncoder().encode(message))
	);
}

function base64(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes));
}

function hexBytes(hex: string): Uint8Array<ArrayBuffer> {
	const bytes = new Uint8Array(hex.length / 2);
	for (let index = 0; index < bytes.length; index += 1)
		bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
	return bytes;
}

// whsec_ and the base64 of 32 bytes: HMAC-SHA256 under a key kept apart from every other use of
// the deployment secret.
export async function endpointSecret(
	rootSecret: string,
	endpointId: string,
	version: number
): Promise<string> {
	if (!Number.isSafeInteger(version) || version < 1)
		throw new Error('Invalid webhook secret version');
	const key = hexBytes(await keyedHash(rootSecret, 'flared:webhook-secrets:v1'));
	return secretPrefix + base64(await hmac(key, `endpoint:${endpointId}:${version}`));
}

// A fingerprint of the deployment secret that is safe to store.
export async function keyId(rootSecret: string): Promise<string> {
	return (await keyedHash(rootSecret, 'flared:webhook-key-id:v1')).slice(0, 16);
}

// The webhook-signature header: one v1 signature of "id.timestamp.body" for each secret,
// separated by a space. The HMAC key is the decoded bytes after whsec_.
export async function signatureHeader(
	secrets: readonly string[],
	id: string,
	timestamp: number,
	body: string
): Promise<string> {
	const signatures = await Promise.all(
		secrets.map(async (secret) => {
			if (!secret.startsWith(secretPrefix)) throw new Error('Invalid webhook secret');
			const key = Uint8Array.from(atob(secret.slice(secretPrefix.length)), (char) =>
				char.charCodeAt(0)
			);
			return `v1,${base64(await hmac(key, `${id}.${timestamp}.${body}`))}`;
		})
	);
	return signatures.join(' ');
}
