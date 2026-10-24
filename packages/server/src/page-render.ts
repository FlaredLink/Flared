// SPDX-License-Identifier: AGPL-3.0-only
// The HTML of a page. It is built on the server with inline CSS and has no script, no cookie, and
// no third-party resource except the players of the embed blocks it shows, which the CSP names
// one by one. Every text comes from the member, so every text is escaped; colours, fonts, and
// shapes come from the theme rules, never from member CSS.
import {
	embedProviders,
	embedSource,
	paymentProviders,
	resolveTheme,
	socialNetworks,
	type ButtonShape,
	type EmbedProvider,
	type PageBlock,
	type PageFont,
	type PageTheme
} from '@flared/contracts/pages';

export interface PageView {
	title: string;
	bio: string | null;
	theme: PageTheme;
	// The address the page shows at, for the canonical link and the card tags.
	url: string;
	// Absolute addresses of the uploaded images on the page's own host.
	avatarUrl: string | null;
	backgroundUrl: string | null;
	// The blocks to show, in order: visible and inside their schedule.
	blocks: PageBlock[];
	// "Made with Flared", on plans without page extras. It links to homeUrl when there is one.
	badge: boolean;
	homeUrl?: string;
}

const escapes: Record<string, string> = {
	'&': '&amp;',
	'<': '&lt;',
	'>': '&gt;',
	'"': '&quot;',
	"'": '&#39;'
};
const escape = (value: string) => value.replace(/[&<>"']/g, (character) => escapes[character]);

const fonts: Record<PageFont, string> = {
	figtree: 'Figtree,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif',
	sans: 'ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif',
	serif: 'ui-serif,Georgia,Cambria,"Times New Roman",serif',
	mono: 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace'
};

const radii: Record<ButtonShape, string> = { square: '0', rounded: '12px', pill: '999px' };

// Players by provider: video keeps 16:9; the others have the height of their player.
const embedHeights: Record<EmbedProvider, string> = {
	youtube: 'aspect-ratio:16/9',
	vimeo: 'aspect-ratio:16/9',
	spotify: 'height:352px',
	applemusic: 'height:450px',
	soundcloud: 'height:166px',
	calcom: 'height:640px',
	calendly: 'height:640px'
};

function styles(view: PageView, embeds: readonly EmbedProvider[]): string {
	const theme = resolveTheme(view.theme);
	const filled = theme.buttonStyle === 'fill';
	const background = view.backgroundUrl
		? `background:var(--bg) url("${view.backgroundUrl}") center/cover fixed;`
		: 'background:var(--bg);';
	const panel = view.backgroundUrl
		? 'main{background:var(--bg);border-radius:20px;padding:28px 20px;box-shadow:0 8px 32px rgb(0 0 0/.18)}'
		: '';
	return [
		`:root{--bg:${theme.background};--text:${theme.text};--button-bg:${theme.buttonBackground};--button-text:${theme.buttonText};--radius:${radii[theme.buttonShape]}}`,
		'*{box-sizing:border-box;margin:0}',
		`body{min-height:100vh;padding:40px 16px;${background}color:var(--text);font:16px/1.5 ${fonts[theme.font]};-webkit-font-smoothing:antialiased}`,
		'main{max-width:36rem;margin:0 auto;display:grid;gap:14px}',
		panel,
		'.profile{display:grid;justify-items:center;gap:10px;text-align:center;margin-bottom:12px}',
		'.avatar{width:96px;height:96px;border-radius:50%;object-fit:cover}',
		'h1{font-size:1.5rem;line-height:1.25;overflow-wrap:anywhere}',
		'.bio{white-space:pre-line;overflow-wrap:anywhere;opacity:.85}',
		'h2{font-size:1.0625rem;text-align:center;margin-top:10px;overflow-wrap:anywhere}',
		`.button{display:block;padding:14px 18px;border-radius:var(--radius);text-align:center;font-weight:600;text-decoration:none;overflow-wrap:anywhere;${filled ? 'background:var(--button-bg);color:var(--button-text);border:2px solid var(--button-bg)' : 'background:transparent;color:var(--button-bg);border:2px solid var(--button-bg)'}}`,
		'.button:hover{opacity:.9}',
		'a:focus-visible{outline:2px solid var(--text);outline-offset:3px}',
		'.social{display:flex;flex-wrap:wrap;justify-content:center;gap:8px;list-style:none;padding:0}',
		'.social a{display:block;padding:6px 12px;border:1px solid color-mix(in srgb,var(--text) 35%,transparent);border-radius:999px;color:var(--text);font-size:.875rem;text-decoration:none}',
		'.card{display:grid;gap:8px;padding:16px;border:1px solid color-mix(in srgb,var(--text) 20%,transparent);border-radius:var(--radius)}',
		'.card h2{margin:0;text-align:left}',
		'.price{font-weight:700}',
		'.card p{overflow-wrap:anywhere}',
		'.note{font-size:.8125rem;opacity:.75}',
		'iframe{display:block;width:100%;border:0;border-radius:12px}',
		...embeds.map((provider) => `.embed-${provider}{${embedHeights[provider]}}`),
		'footer{margin-top:24px;text-align:center;font-size:.8125rem;opacity:.75}',
		'footer a{color:inherit}'
	]
		.filter(Boolean)
		.join('');
}

// Stored blocks passed the input rules when they were saved; a block whose provider or network
// is not in the current lists is left out rather than shown wrong.
const known = (list: object, key: string) => Object.hasOwn(list, key);

function block(item: PageBlock): string {
	switch (item.kind) {
		case 'button':
			return `<a class="button" href="${escape(item.shortUrl)}">${escape(item.label)}</a>`;
		case 'header':
			return `<h2>${escape(item.label)}</h2>`;
		case 'social': {
			const links = item.links
				.filter((link) => known(socialNetworks, link.network))
				.map((link) => {
					const href = link.network === 'email' ? `mailto:${link.address}` : link.address;
					return `<li><a href="${escape(href)}" rel="me">${escape(socialNetworks[link.network].name)}</a></li>`;
				});
			return `<ul class="social">${links.join('')}</ul>`;
		}
		case 'payment': {
			if (!known(paymentProviders, item.provider)) return '';
			const provider = paymentProviders[item.provider].name;
			const price = item.price === null ? '' : `<p class="price">${escape(item.price)}</p>`;
			const description = item.description === null ? '' : `<p>${escape(item.description)}</p>`;
			return `<section class="card"><h2>${escape(item.label)}</h2>${price}${description}<a class="button" href="${escape(item.shortUrl)}">Buy</a><p class="note">You pay on ${escape(provider)}.</p></section>`;
		}
		case 'embed': {
			if (!known(embedProviders, item.provider)) return '';
			const source = embedSource(item.provider, item.address);
			if (source === null) return '';
			const name = embedProviders[item.provider].name;
			return `<iframe class="embed-${item.provider}" src="${escape(source)}" title="${escape(name)}" loading="lazy" sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-presentation" allow="encrypted-media; fullscreen; picture-in-picture" referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
		}
		case 'signup':
			// Sign-up entries need their own store and bot check; until then the form is not shown.
			return '';
	}
}

// The page and its Content Security Policy. frame-src lists only the players the page shows.
export function renderPage(view: PageView): { html: string; contentSecurityPolicy: string } {
	const embeds = [
		...new Set(
			view.blocks.flatMap((item) =>
				item.kind === 'embed' &&
				known(embedProviders, item.provider) &&
				embedSource(item.provider, item.address) !== null
					? [item.provider]
					: []
			)
		)
	];
	const title = escape(view.title);
	const url = escape(view.url);
	const tags = [
		`<link rel="canonical" href="${url}">`,
		'<meta property="og:type" content="profile">',
		`<meta property="og:url" content="${url}">`,
		`<meta property="og:title" content="${title}">`,
		`<meta name="twitter:card" content="summary">`
	];
	if (view.bio !== null) {
		const bio = escape(view.bio);
		tags.push(
			`<meta name="description" content="${bio}">`,
			`<meta property="og:description" content="${bio}">`
		);
	}
	if (view.avatarUrl !== null)
		tags.push(`<meta property="og:image" content="${escape(view.avatarUrl)}">`);
	const avatar =
		view.avatarUrl === null
			? ''
			: `<img class="avatar" src="${escape(view.avatarUrl)}" alt="" width="96" height="96">`;
	const bio = view.bio === null ? '' : `<p class="bio">${escape(view.bio)}</p>`;
	const badge = !view.badge
		? ''
		: view.homeUrl
			? `<footer><a href="${escape(view.homeUrl)}">Made with Flared</a></footer>`
			: '<footer>Made with Flared</footer>';
	const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>${tags.join('')}<style>${styles(view, embeds)}</style></head><body><main><header class="profile">${avatar}<h1>${title}</h1>${bio}</header>${view.blocks.map(block).join('')}${badge}</main></body></html>`;
	const frames = embeds.map((provider) => embedProviders[provider].frame);
	const contentSecurityPolicy = [
		"default-src 'none'",
		"style-src 'unsafe-inline'",
		"img-src 'self'",
		...(frames.length > 0 ? [`frame-src ${frames.join(' ')}`] : []),
		"base-uri 'none'",
		"form-action 'none'",
		"frame-ancestors 'none'"
	].join('; ');
	return { html, contentSecurityPolicy };
}
