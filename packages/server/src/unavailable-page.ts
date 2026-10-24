// SPDX-License-Identifier: AGPL-3.0-only
// The page a browser sees when a short link cannot open. It is static: it never repeats the
// requested address, and an unknown link looks the same as a disabled one.

export type UnavailableReason = 'not-found' | 'blocked' | 'unavailable' | 'not-open' | 'ended';

const copy: Record<UnavailableReason, { title: string; heading: string; text: string }> = {
	'not-found': {
		title: 'Link not available',
		heading: 'This link isn’t available',
		text: 'Its owner may have turned it off, or the address may be wrong. Check the link with the person who shared it.'
	},
	blocked: {
		title: 'Link blocked',
		heading: 'This link was blocked',
		text: 'Flared blocked this link because it broke the rules for short links, for example with phishing or malware. Do not enter passwords or payment details on a page that this link sent you to before.'
	},
	unavailable: {
		title: 'Link can’t open right now',
		heading: 'This link can’t open right now',
		text: 'Something went wrong on our side. Try the link again in a minute.'
	},
	'not-open': {
		title: 'Link not open yet',
		heading: 'This link isn’t open yet',
		text: 'Its owner set a start time. Try the link again later.'
	},
	ended: {
		title: 'Link ended',
		heading: 'This link has ended',
		text: 'Its owner set an end time, and it has passed. Check the link with the person who shared it.'
	}
};

const styles = `
:root{color-scheme:light dark;--paper:#fff;--ink:#3f4450;--strong:#14161a;--muted:#646a76;--rule:#e4e6ea;--accent:#c94b00;--danger:#b42318}
@media (prefers-color-scheme:dark){:root{--paper:#121316;--ink:#c9ccd3;--strong:#f3f4f6;--muted:#9097a3;--rule:#2a2d33;--accent:#ff7a2e;--danger:#ff8a80}}
*{box-sizing:border-box;margin:0}
body{min-height:100vh;display:grid;place-items:center;padding:24px 16px;background:var(--paper);color:var(--ink);font:16px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{width:100%;max-width:26rem;display:grid;gap:14px}
svg{width:42px;height:42px;margin-bottom:10px;color:var(--strong)}
h1{color:var(--strong);font-size:1.6rem;line-height:1.2;letter-spacing:-0.01em}
p{color:var(--muted)}
form{display:grid;gap:10px;margin-top:4px}
label{color:var(--strong);font-weight:600;font-size:.9375rem}
input{width:100%;padding:10px 12px;border:1px solid var(--rule);border-radius:8px;background:var(--paper);color:var(--strong);font:inherit}
input:focus-visible,button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
button{padding:10px 14px;border:0;border-radius:8px;background:var(--strong);color:var(--paper);font:inherit;font-weight:600;cursor:pointer}
.error{color:var(--danger);font-weight:600}
footer{margin-top:18px;padding-top:14px;border-top:1px solid var(--rule);font-size:.875rem;color:var(--muted)}
a{color:var(--accent);font-weight:600;text-underline-offset:3px}
a:focus-visible{outline:2px solid var(--accent);outline-offset:3px;border-radius:2px}`;

const mark =
	'<svg viewBox="0 0 21 21" shape-rendering="crispEdges" aria-hidden="true"><path fill="currentColor" d="M13 0h4v1h-4zM11 1h8v1h-8zM10 2h3v1h-3zM17 2h3v1h-3zM10 3h2v1h-2zM18 3h2v1h-2zM9 4h2v1h-2zM19 4h2v1h-2zM9 5h2v1h-2zM19 5h2v1h-2zM9 6h2v1h-2zM19 6h2v1h-2zM9 7h2v1h-2zM19 7h2v1h-2zM10 8h2v1h-2zM18 8h2v1h-2zM4 9h4v1h-4zM10 9h3v1h-3zM17 9h3v1h-3zM2 10h17v1h-17zM1 11h3v1h-3zM8 11h3v1h-3zM13 11h4v1h-4zM1 12h2v1h-2zM9 12h2v1h-2zM0 13h2v1h-2zM10 13h2v1h-2zM0 14h2v1h-2zM10 14h2v1h-2zM0 15h2v1h-2zM10 15h2v1h-2zM0 16h2v1h-2zM10 16h2v1h-2zM1 17h2v1h-2zM9 17h2v1h-2zM1 18h3v1h-3zM8 18h3v1h-3zM2 19h8v1h-8zM4 20h4v1h-4z"/></svg>';

const escapes: Record<string, string> = {
	'&': '&amp;',
	'<': '&lt;',
	'>': '&gt;',
	'"': '&quot;',
	"'": '&#39;'
};
const escape = (value: string) => value.replace(/[&<>"']/g, (character) => escapes[character]);

// The URLs come from deployment configuration, never from the request. Only the blocked page
// links to the report form.
export function unavailablePage(
	reason: UnavailableReason,
	links: { homeUrl?: string; reportUrl?: string } = {}
): string {
	const { title, heading, text } = copy[reason];
	const report =
		reason === 'blocked' && links.reportUrl
			? `<p><a href="${escape(links.reportUrl)}">Report another link</a></p>`
			: '';
	const footer = links.homeUrl
		? `<footer>Short links by <a href="${escape(links.homeUrl)}">Flared</a></footer>`
		: '';
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title><style>${styles}</style></head><body><main>${mark}<h1>${heading}</h1><p>${text}</p>${report}${footer}</main></body></html>`;
}

export type PasswordPageError = 'wrong' | 'missing' | 'too-many';

const passwordErrors: Record<PasswordPageError, string> = {
	wrong: 'Wrong password. Try again.',
	missing: 'Enter the password.',
	'too-many': 'Too many tries. Wait a minute and try again.'
};

// The form posts to the page's own address. It never repeats the link's address or the typed
// password.
export function passwordPage(
	error: PasswordPageError | null,
	links: { homeUrl?: string } = {}
): string {
	const message = error
		? `<p class="error" id="password-error" role="alert">${passwordErrors[error]}</p>`
		: '';
	const described = error ? ' aria-describedby="password-error" aria-invalid="true"' : '';
	const footer = links.homeUrl
		? `<footer>Short links by <a href="${escape(links.homeUrl)}">Flared</a></footer>`
		: '';
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Password required</title><style>${styles}</style></head><body><main>${mark}<h1>This link needs a password</h1><p>Enter the password that the person who shared the link gave you.</p><form method="post"><label for="password">Password</label><input id="password" name="password" type="password" required maxlength="128" autocomplete="current-password" autofocus${described}>${message}<button type="submit">Open link</button></form>${footer}</main></body></html>`;
}

export const passwordPageHeaders: Record<string, string> = {
	'content-type': 'text/html; charset=utf-8',
	'content-security-policy':
		"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
	'x-content-type-options': 'nosniff',
	'referrer-policy': 'no-referrer',
	'x-robots-tag': 'noindex'
};

export const unavailablePageHeaders: Record<string, string> = {
	'content-type': 'text/html; charset=utf-8',
	'content-security-policy':
		"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
	'x-content-type-options': 'nosniff',
	'referrer-policy': 'no-referrer',
	'x-robots-tag': 'noindex'
};
