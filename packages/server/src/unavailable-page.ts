// SPDX-License-Identifier: AGPL-3.0-only
// The page a browser sees when a short link cannot open. It is static: it never repeats the
// requested address, and an unknown link looks the same as a disabled one.

export type UnavailableReason = 'not-found' | 'unavailable';

const copy: Record<UnavailableReason, { title: string; heading: string; text: string }> = {
	'not-found': {
		title: 'Link not available',
		heading: 'This link isn’t available',
		text: 'Its owner may have turned it off, or the address may be wrong. Check the link with the person who shared it.'
	},
	unavailable: {
		title: 'Link can’t open right now',
		heading: 'This link can’t open right now',
		text: 'Something went wrong on our side. Try the link again in a minute.'
	}
};

const styles = `
:root{color-scheme:light dark;--paper:#fff;--ink:#3f4450;--strong:#14161a;--muted:#646a76;--rule:#e4e6ea;--accent:#c94b00}
@media (prefers-color-scheme:dark){:root{--paper:#121316;--ink:#c9ccd3;--strong:#f3f4f6;--muted:#9097a3;--rule:#2a2d33;--accent:#ff7a2e}}
*{box-sizing:border-box;margin:0}
body{min-height:100vh;display:grid;place-items:center;padding:24px 16px;background:var(--paper);color:var(--ink);font:16px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{width:100%;max-width:26rem;display:grid;gap:14px}
svg{width:40px;height:40px;margin-bottom:10px;color:var(--accent)}
h1{color:var(--strong);font-size:1.6rem;line-height:1.2;letter-spacing:-0.01em}
p{color:var(--muted)}
footer{margin-top:18px;padding-top:14px;border-top:1px solid var(--rule);font-size:.875rem;color:var(--muted)}
a{color:var(--accent);font-weight:600;text-underline-offset:3px}
a:focus-visible{outline:2px solid var(--accent);outline-offset:3px;border-radius:2px}`;

const mark =
	'<svg viewBox="0 0 64 64" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="square" stroke-linejoin="round"><path d="M28 19H20L8 31V45H22L34 33V27"/><path d="M36 45H44L56 33V19H42L30 31V37"/></g></svg>';

const escapes: Record<string, string> = {
	'&': '&amp;',
	'<': '&lt;',
	'>': '&gt;',
	'"': '&quot;',
	"'": '&#39;'
};
const escape = (value: string) => value.replace(/[&<>"']/g, (character) => escapes[character]);

// homeUrl comes from deployment configuration, never from the request.
export function unavailablePage(reason: UnavailableReason, homeUrl?: string): string {
	const { title, heading, text } = copy[reason];
	const footer = homeUrl
		? `<footer>Short links by <a href="${escape(homeUrl)}">Flared</a></footer>`
		: '';
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title><style>${styles}</style></head><body><main>${mark}<h1>${heading}</h1><p>${text}</p>${footer}</main></body></html>`;
}

export const unavailablePageHeaders: Record<string, string> = {
	'content-type': 'text/html; charset=utf-8',
	'content-security-policy':
		"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
	'x-content-type-options': 'nosniff',
	'referrer-policy': 'no-referrer',
	'x-robots-tag': 'noindex'
};
