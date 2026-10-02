// SPDX-License-Identifier: AGPL-3.0-only
// Browser side of the passkey ceremonies. Every edition serves the same auth routes, and each
// route answers with { ok: true }, { options }, or { error: { code } }.
import {
	browserSupportsWebAuthn,
	browserSupportsWebAuthnAutofill,
	startAuthentication,
	startRegistration,
	type PublicKeyCredentialCreationOptionsJSON,
	type PublicKeyCredentialRequestOptionsJSON
} from '@simplewebauthn/browser';

export const passkeyRoutes = {
	signInOptions: '/api/auth/passkey/sign-in/options',
	signInVerify: '/api/auth/passkey/sign-in/verify',
	registerOptions: '/api/auth/passkey/register/options',
	registerVerify: '/api/auth/passkey/register/verify',
	list: '/api/auth/passkeys',
	rename: '/api/auth/passkey/rename',
	delete: '/api/auth/passkey/delete',
	// Confirms the signed-in user with one of their own passkeys; a fresh sign-in follows.
	reauthOptions: '/api/auth/reauth/passkey/options',
	reauthVerify: '/api/auth/reauth/passkey/verify'
} as const;

// CANCELLED: the person closed the browser prompt or it timed out. UNSUPPORTED: no WebAuthn.
export type PasskeyResult = { ok: true } | { ok: false; code: string };

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function post(path: string, body: unknown): Promise<{ status: number; value: unknown }> {
	try {
		const response = await fetch(path, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
		return { status: response.status, value: await response.json().catch(() => null) };
	} catch {
		return { status: 503, value: null };
	}
}

function outcome({ value }: { value: unknown }): PasskeyResult {
	if (record(value) && value.ok === true) return { ok: true };
	const error = record(value) && record(value.error) ? value.error : null;
	return {
		ok: false,
		code: error && typeof error.code === 'string' ? error.code : 'AUTH_UNAVAILABLE'
	};
}

// The options come from the pinned server library; a challenge string is the part the browser
// cannot work without, so it is the shape check before the hand-off.
function options(value: unknown): Record<string, unknown> | null {
	if (!record(value) || !record(value.options) || typeof value.options.challenge !== 'string')
		return null;
	return value.options;
}

function failure(error: unknown): PasskeyResult {
	const name = error instanceof Error ? error.name : '';
	return {
		ok: false,
		code: name === 'NotAllowedError' || name === 'AbortError' ? 'CANCELLED' : 'PASSKEY_FAILED'
	};
}

export function passkeysSupported(): boolean {
	return browserSupportsWebAuthn();
}

export function passkeyAutofillSupported(): Promise<boolean> {
	return browserSupportsWebAuthnAutofill();
}

// With autofill, the browser offers saved passkeys from an input marked
// autocomplete="username webauthn" and waits until the person picks one.
export function signInWithPasskey(autofill = false): Promise<PasskeyResult> {
	return authenticate(passkeyRoutes.signInOptions, passkeyRoutes.signInVerify, autofill);
}

export function confirmWithPasskey(): Promise<PasskeyResult> {
	return authenticate(passkeyRoutes.reauthOptions, passkeyRoutes.reauthVerify, false);
}

async function authenticate(
	optionsPath: string,
	verifyPath: string,
	autofill: boolean
): Promise<PasskeyResult> {
	if (!passkeysSupported()) return { ok: false, code: 'UNSUPPORTED' };
	const issued = await post(optionsPath, {});
	const optionsJSON = options(issued.value);
	if (!optionsJSON) return outcome(issued);
	let response: unknown;
	try {
		response = await startAuthentication({
			optionsJSON: optionsJSON as unknown as PublicKeyCredentialRequestOptionsJSON,
			useBrowserAutofill: autofill
		});
	} catch (error) {
		return failure(error);
	}
	return outcome(await post(verifyPath, { response }));
}

export async function addPasskey(name: string): Promise<PasskeyResult> {
	if (!passkeysSupported()) return { ok: false, code: 'UNSUPPORTED' };
	const issued = await post(passkeyRoutes.registerOptions, {});
	const optionsJSON = options(issued.value);
	if (!optionsJSON) return outcome(issued);
	let response: unknown;
	try {
		response = await startRegistration({
			optionsJSON: optionsJSON as unknown as PublicKeyCredentialCreationOptionsJSON
		});
	} catch (error) {
		return failure(error);
	}
	return outcome(await post(passkeyRoutes.registerVerify, { response, name }));
}

export async function renamePasskey(id: string, name: string): Promise<PasskeyResult> {
	return outcome(await post(passkeyRoutes.rename, { id, name }));
}

export async function deletePasskey(id: string): Promise<PasskeyResult> {
	return outcome(await post(passkeyRoutes.delete, { id }));
}

const messages: Record<string, string> = {
	CANCELLED: 'The passkey prompt was closed. Try again when you are ready.',
	UNSUPPORTED: 'This browser cannot use passkeys.',
	REAUTH_REQUIRED: 'Confirm it is you before you change passkeys.',
	PASSKEY_REJECTED: 'That passkey was not accepted. Try again or use another one.',
	INVALID_REQUEST: 'Use a name of 1 to 64 characters.',
	RATE_LIMITED: 'Too many attempts. Wait a few minutes and try again.',
	UNAUTHENTICATED: 'Your session ended. Sign in again.',
	NOT_FOUND: 'That passkey no longer exists.'
};

export function passkeyErrorMessage(code: string): string {
	return messages[code] ?? 'Passkeys are not available right now. Try again.';
}
