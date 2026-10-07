// SPDX-License-Identifier: AGPL-3.0-only
// Plain pages for the operator, served before the app can run. They hold no secret value and
// load nothing from another origin.
import type { ConfigProblem } from './config';

function escape(value: string): string {
	return value.replace(
		/[&<>"']/g,
		(character) =>
			({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ??
			character
	);
}

const style = `body{margin:0;font:16px/1.6 system-ui,sans-serif;color:#262626;background:#fff}
main{max-width:40rem;margin:4rem auto;padding:0 1.25rem}h1{font-size:1.5rem;line-height:1.3}
code{padding:.1rem .3rem;border:1px solid #e5e5e5;border-radius:4px;font-size:.9em;overflow-wrap:anywhere}
a{color:#b84400}`;

// Paragraphs are HTML built only from escaped values.
function page(title: string, paragraphs: string[], status = 503): Response {
	const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escape(title)}</title><style>${style}</style></head><body><main><h1>${escape(title)}</h1>${paragraphs.map((paragraph) => `<p>${paragraph}</p>`).join('')}</main></body></html>`;
	return new Response(body, {
		status,
		headers: {
			'content-type': 'text/html; charset=utf-8',
			'cache-control': 'no-store',
			'x-robots-tag': 'noindex',
			'referrer-policy': 'no-referrer',
			'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'"
		}
	});
}

// The value shown for APP_ORIGIN is only a suggestion from the address this request used; the
// Worker never stores it.
export function configurationPage(problem: ConfigProblem, request: Request): Response {
	const suggested = new URL(request.url).origin;
	if (problem === 'APP_ORIGIN')
		return page('Set APP_ORIGIN to finish the deployment', [
			'This Flared installation does not know its own address yet. In the Cloudflare dashboard, open this Worker, then <b>Settings → Variables and Secrets</b>, and add the secret <code>APP_ORIGIN</code>.',
			`If people will use this address, the value is <code>${escape(suggested)}</code>. Use <code>https://</code> and no path.`,
			'Then deploy again. See docs/self-hosting/deploy.md in the repository.'
		]);
	if (problem === 'AUTH_SECRET')
		return page('Set AUTH_SECRET to finish the deployment', [
			'Add the secret <code>AUTH_SECRET</code> to this Worker: a random value of 32 to 256 characters. Do not reuse <code>SETUP_SECRET</code>.',
			'Then deploy again. See docs/self-hosting/deploy.md in the repository.'
		]);
	return page('The databases are not bound', [
		'This Worker needs the D1 bindings <code>IDENTITY</code>, <code>ROUTING</code>, and <code>ANALYTICS_1</code>. Check the Wrangler configuration of your copy, then deploy again.'
	]);
}

export function misconfiguredPage(): Response {
	return page('This database belongs to another kind of installation', [
		'The identity database of this Worker is set up for several workspaces. A standalone installation needs its own, new identity database.'
	]);
}

export function originMovePage(from: string, to: string): Response {
	return page('This installation is moving to a new address', [
		`The app moves from <code>${escape(from)}</code> to <code>${escape(to)}</code>. Sign in with your username and password at the new address to finish the move.`,
		'Signing in ends every session, connected app, and passkey of the old address. API tokens keep working. Short links on the old address keep working.',
		`<a href="/app/login">Sign in at ${escape(to)}</a>`
	]);
}
