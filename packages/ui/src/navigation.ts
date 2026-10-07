// SPDX-License-Identifier: AGPL-3.0-only
// Where sign-in continues. Only same-origin paths under /app/ are accepted, so a crafted link
// cannot send a new session to another site, and sign-in never returns to the sign-in page.
import { resumeAuthorizationPath } from '@flared/contracts/oauth';

const base = 'https://flared.invalid';

export function safeNextPath(value: string | null | undefined): string | null {
	if (typeof value !== 'string' || value.length > 512 || !value.startsWith('/app/')) return null;
	// Backslashes and control characters can turn a path into another host in some parsers.
	if (/[\\\u0000-\u001f\u007f]/.test(value)) return null;
	let url: URL;
	try {
		url = new URL(value, base);
	} catch {
		return null;
	}
	if (url.origin !== base || !url.pathname.startsWith('/app/')) return null;
	if (/^\/app\/(?:login|verify)(?:\/|$)/.test(url.pathname)) return null;
	return `${url.pathname}${url.search}`;
}

// The safe destination from a page's query, or null.
export function nextFromSearch(search: string): string | null {
	return safeNextPath(new URLSearchParams(search).get('next'));
}

// The path that continues an app's authorization request in the page's query, or null.
export function pendingAuthorization(search: string): string | null {
	const query = search.startsWith('?') ? search.slice(1) : search;
	return new URLSearchParams(query).has('sig') ? resumeAuthorizationPath(query) : null;
}
