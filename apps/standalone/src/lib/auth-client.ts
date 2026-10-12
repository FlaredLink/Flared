// SPDX-License-Identifier: AGPL-3.0-only
// Browser calls to the owner's auth routes and setup. The browser sends its own Origin, which
// each route checks.
export type AuthResult =
	{ ok: true } | { ok: false; status: number; code: string; retryAfter?: number };

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function postJson(path: string, body: Record<string, unknown>): Promise<AuthResult> {
	try {
		const response = await fetch(path, {
			method: 'POST',
			credentials: 'same-origin',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
		const result: unknown = await response.json().catch(() => null);
		if (response.ok && record(result) && result.ok === true) return { ok: true };
		const error = record(result) && record(result.error) ? result.error : null;
		const retry = record(result) ? result.retryAfter : undefined;
		return {
			ok: false,
			status: response.status,
			code: error && typeof error.code === 'string' ? error.code : 'AUTH_UNAVAILABLE',
			retryAfter: typeof retry === 'number' && Number.isSafeInteger(retry) ? retry : undefined
		};
	} catch {
		return { ok: false, status: 503, code: 'AUTH_UNAVAILABLE' };
	}
}

// Reads what an invite or reset link opens. ended: the link no longer works.
export async function lookupLink(
	path: string,
	token: string
): Promise<{ ok: true; body: unknown } | { ok: false; ended: boolean; code: string }> {
	try {
		const response = await fetch(path, {
			method: 'POST',
			credentials: 'same-origin',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ token })
		});
		const body: unknown = await response.json().catch(() => null);
		if (response.ok) return { ok: true, body };
		const error = record(body) && record(body.error) ? body.error : null;
		const code = error && typeof error.code === 'string' ? error.code : 'AUTH_UNAVAILABLE';
		return {
			ok: false,
			ended:
				code === 'INVITE_NOT_FOUND' || code === 'RESET_NOT_FOUND' || code === 'INVALID_REQUEST',
			code
		};
	} catch {
		return { ok: false, ended: false, code: 'AUTH_UNAVAILABLE' };
	}
}

export function authErrorMessage(code: string): string {
	switch (code) {
		case 'INVITE_NOT_FOUND':
			return 'This invite has ended or was already used. Ask the workspace owner for a new link.';
		case 'RESET_NOT_FOUND':
			return 'This reset link has ended or was already used. Ask the workspace owner for a new one.';
		case 'USERNAME_TAKEN':
			return 'This username is taken. Choose another one.';
		case 'INVALID_CREDENTIALS':
			return 'The username or password is not correct.';
		case 'RATE_LIMITED':
			return 'Too many attempts. Wait a few minutes and try again.';
		case 'REAUTH_REQUIRED':
			return 'Confirm it’s you first.';
		case 'INVALID_REQUEST':
			return 'Check the fields and try again.';
		case 'INVALID_ORIGIN':
			return 'Open this page at the app address and try again.';
		default:
			return 'This is not available right now. Try again.';
	}
}
