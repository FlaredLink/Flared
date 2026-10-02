// SPDX-License-Identifier: AGPL-3.0-only
// Browser calls for connected apps: the consent decision and revocation. The browser sends the
// session cookie and its Origin with each call.

export type ConsentResult = { ok: true; redirectTo: string } | { ok: false; code: string };
export type RevokeResult = { ok: true } | { ok: false; code: string };

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Sends the decision for the signed authorization request the consent page received. On
// success, the browser goes to redirectTo, which returns it to the app.
export async function decideConsent(oauthQuery: string, accept: boolean): Promise<ConsentResult> {
	try {
		const response = await fetch('/oauth2/consent', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ accept, oauth_query: oauthQuery })
		});
		const body: unknown = await response.json().catch(() => null);
		if (response.ok && record(body) && typeof body.redirectTo === 'string')
			return { ok: true, redirectTo: body.redirectTo };
		return {
			ok: false,
			code: record(body) && typeof body.error === 'string' ? body.error : 'temporarily_unavailable'
		};
	} catch {
		return { ok: false, code: 'temporarily_unavailable' };
	}
}

export async function revokeConnectedApp(apiBase: string, clientId: string): Promise<RevokeResult> {
	try {
		const response = await fetch(`${apiBase}/connected-apps/${encodeURIComponent(clientId)}`, {
			method: 'DELETE'
		});
		if (response.status === 204) return { ok: true };
		const body: unknown = await response.json().catch(() => null);
		return {
			ok: false,
			code:
				record(body) && record(body.error) && typeof body.error.code === 'string'
					? body.error.code
					: 'SERVICE_UNAVAILABLE'
		};
	} catch {
		return { ok: false, code: 'SERVICE_UNAVAILABLE' };
	}
}

export function consentErrorMessage(code: string): string {
	switch (code) {
		case 'login_required':
			return 'Your session ended. Sign in again, then start the connection again in the app.';
		case 'invalid_request':
		case 'invalid_client':
			return 'This request has expired. Start the connection again in the app.';
		case 'workspace_unavailable':
			return 'Your workspace is not ready yet. Try again in a moment.';
		default:
			return 'Something went wrong. Try again.';
	}
}
