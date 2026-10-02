// SPDX-License-Identifier: AGPL-3.0-only
// Browser calls to the token routes of the /v1 API. The page passes its API base path, and the
// browser sends the session cookie and its Origin with each change.
import {
	isCreatedApiToken,
	type CreateTokenInput,
	type CreatedApiToken
} from '@flared/contracts/tokens';

export type TokenResult<T> = { ok: true; value: T } | { ok: false; code: string };

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function errorCode(response: Response): Promise<string> {
	const body: unknown = await response.json().catch(() => null);
	return record(body) && record(body.error) && typeof body.error.code === 'string'
		? body.error.code
		: 'SERVICE_UNAVAILABLE';
}

export async function createApiToken(
	apiBase: string,
	input: CreateTokenInput
): Promise<TokenResult<CreatedApiToken>> {
	try {
		const response = await fetch(`${apiBase}/tokens`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(input)
		});
		if (response.status !== 201) return { ok: false, code: await errorCode(response) };
		const body: unknown = await response.json();
		return isCreatedApiToken(body)
			? { ok: true, value: body }
			: { ok: false, code: 'SERVICE_UNAVAILABLE' };
	} catch {
		return { ok: false, code: 'SERVICE_UNAVAILABLE' };
	}
}

export async function revokeApiToken(apiBase: string, id: string): Promise<TokenResult<null>> {
	try {
		const response = await fetch(`${apiBase}/tokens/${encodeURIComponent(id)}`, {
			method: 'DELETE'
		});
		return response.status === 204
			? { ok: true, value: null }
			: { ok: false, code: await errorCode(response) };
	} catch {
		return { ok: false, code: 'SERVICE_UNAVAILABLE' };
	}
}

export function tokenErrorMessage(code: string): string {
	switch (code) {
		case 'REAUTH_REQUIRED':
			return 'Confirm it’s you, then create the token again.';
		case 'TOKEN_LIMIT_REACHED':
			return 'You have 25 tokens. Revoke one before you create another.';
		case 'INVALID_INPUT':
			return 'Give the token a name and choose at least one scope.';
		case 'NOT_FOUND':
			return 'This token was already revoked.';
		case 'UNAUTHENTICATED':
			return 'Your session ended. Sign in again.';
		default:
			return 'Something went wrong. Try again.';
	}
}
