// SPDX-License-Identifier: AGPL-3.0-only
// Request bodies of the shared authentication routes. Edition sign-in routes build on
// exactRecord and AuthInputError for their own bodies.
import { parsePasskeyName } from '@flared/contracts/passkeys';
export class AuthInputError extends Error {
	constructor(
		public readonly status: 400 | 403 | 413,
		public readonly code: 'INVALID_REQUEST' | 'INVALID_ORIGIN' | 'BODY_TOO_LARGE'
	) {
		super(code);
	}
}
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function exactRecord(value: unknown, keys: string[]): Record<string, unknown> {
	if (!isRecord(value)) throw new AuthInputError(400, 'INVALID_REQUEST');
	const record: Record<string, unknown> = value;
	if (
		Object.keys(record).length !== keys.length ||
		Object.keys(record).some((key) => !keys.includes(key))
	)
		throw new AuthInputError(400, 'INVALID_REQUEST');
	return record;
}
const transports = ['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb'] as const;
type Transport = (typeof transports)[number];
function base64url(value: unknown): string {
	if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,2048}$/.test(value))
		throw new AuthInputError(400, 'INVALID_REQUEST');
	return value;
}
function optionalBase64url(value: unknown): string | undefined {
	return value === undefined ? undefined : base64url(value);
}
function credential(value: unknown): {
	id: string;
	rawId: string;
	response: Record<string, unknown>;
	authenticatorAttachment?: 'platform' | 'cross-platform';
} {
	if (!isRecord(value) || value.type !== 'public-key' || !isRecord(value.response))
		throw new AuthInputError(400, 'INVALID_REQUEST');
	const attachment = value.authenticatorAttachment;
	if (attachment !== undefined && attachment !== 'platform' && attachment !== 'cross-platform')
		throw new AuthInputError(400, 'INVALID_REQUEST');
	return {
		id: base64url(value.id),
		rawId: base64url(value.rawId),
		response: value.response,
		...(attachment ? { authenticatorAttachment: attachment } : {})
	};
}
// The pinned library verifies the WebAuthn content. These copy only the fields it reads, so a
// request cannot pass anything else through. Extension outputs are not used and are dropped.
export function passkeySignInBody(value: unknown) {
	const record = exactRecord(value, ['response']);
	const { response, ...rest } = credential(record.response);
	return {
		response: {
			...rest,
			type: 'public-key' as const,
			clientExtensionResults: {},
			response: {
				clientDataJSON: base64url(response.clientDataJSON),
				authenticatorData: base64url(response.authenticatorData),
				signature: base64url(response.signature),
				userHandle: optionalBase64url(response.userHandle)
			}
		}
	};
}
export function passkeyRegistrationBody(value: unknown) {
	const record = exactRecord(value, ['response', 'name']);
	const name = parsePasskeyName(record.name);
	if (name === null) throw new AuthInputError(400, 'INVALID_REQUEST');
	const { response, ...rest } = credential(record.response);
	const listed = response.transports ?? [];
	if (
		!Array.isArray(listed) ||
		listed.some((item) => !transports.some((transport) => transport === item))
	)
		throw new AuthInputError(400, 'INVALID_REQUEST');
	return {
		name,
		response: {
			...rest,
			type: 'public-key' as const,
			clientExtensionResults: {},
			response: {
				clientDataJSON: base64url(response.clientDataJSON),
				attestationObject: base64url(response.attestationObject),
				transports: transports.filter((transport): transport is Transport =>
					listed.includes(transport)
				)
			}
		}
	};
}
function passkeyId(value: unknown): string {
	if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value))
		throw new AuthInputError(400, 'INVALID_REQUEST');
	return value;
}
export function passkeyIdBody(value: unknown): { id: string } {
	return { id: passkeyId(exactRecord(value, ['id']).id) };
}
export function passkeyRenameBody(value: unknown): { id: string; name: string } {
	const record = exactRecord(value, ['id', 'name']);
	const name = parsePasskeyName(record.name);
	if (name === null) throw new AuthInputError(400, 'INVALID_REQUEST');
	return { id: passkeyId(record.id), name };
}
export function emptyBody(value: unknown): void {
	exactRecord(value, []);
}
export async function readAuthBody(request: Request, origin: string): Promise<unknown> {
	if (request.headers.get('origin') !== origin) throw new AuthInputError(403, 'INVALID_ORIGIN');
	if (
		request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json'
	)
		throw new AuthInputError(400, 'INVALID_REQUEST');
	const reader = request.body?.getReader();
	if (!reader) throw new AuthInputError(400, 'INVALID_REQUEST');
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			length += chunk.value.byteLength;
			if (length > 4096) {
				await reader.cancel();
				throw new AuthInputError(413, 'BODY_TOO_LARGE');
			}
			chunks.push(chunk.value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
	} catch {
		throw new AuthInputError(400, 'INVALID_REQUEST');
	}
}
