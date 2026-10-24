// SPDX-License-Identifier: AGPL-3.0-only
// Social previews on short links. A card bot, such as Slack's or LinkedIn's, normally follows the
// redirect and reads the destination's own tags. For a link with a preview title, description,
// or image, it gets a small page with Open Graph and Twitter card tags instead. People and other
// clients always get the redirect.

// The fetchers that build link cards in chat apps and social networks, by user agent. Search
// crawlers are left out, so search results keep the destination. Apple Messages and Threads
// send facebookexternalhit or Twitterbot.
const cardAgents = [
	/facebookexternalhit|facebot/i,
	/twitterbot/i,
	/linkedinbot/i,
	/slackbot/i,
	/discordbot/i,
	/telegrambot/i,
	/whatsapp\//i,
	/skypeuripreview|microsoftpreview/i,
	/pinterest(?:bot)?\//i,
	/redditbot/i,
	/mastodon\//i,
	/bluesky cardyb/i,
	/snap url preview/i,
	/google-pagerenderer/i,
	/embedly|iframely|vkshare/i
];

export function isCardFetcher(userAgent: string | null): boolean {
	const agent = userAgent ?? '';
	return cardAgents.some((pattern) => pattern.test(agent));
}

export interface LinkCard {
	shortUrl: string;
	title: string;
	description: string | null;
	// An absolute URL on the short-link host.
	image: string | null;
}

const escapes: Record<string, string> = {
	'&': '&amp;',
	'<': '&lt;',
	'>': '&gt;',
	'"': '&quot;',
	"'": '&#39;'
};
const escape = (value: string) => value.replace(/[&<>"']/g, (character) => escapes[character]);

// The page names the short link, never the destination, so a link with a password or a start
// time tells a bot nothing that the owner did not write for the card.
export function linkCardPage(card: LinkCard): string {
	const title = escape(card.title);
	const tags = [
		'<meta property="og:type" content="website">',
		`<meta property="og:url" content="${escape(card.shortUrl)}">`,
		`<meta property="og:title" content="${title}">`,
		`<meta name="twitter:card" content="${card.image ? 'summary_large_image' : 'summary'}">`
	];
	if (card.description !== null) {
		const description = escape(card.description);
		tags.push(
			`<meta name="description" content="${description}">`,
			`<meta property="og:description" content="${description}">`
		);
	}
	if (card.image !== null) tags.push(`<meta property="og:image" content="${escape(card.image)}">`);
	const text = card.description === null ? '' : `<p>${escape(card.description)}</p>`;
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>${title}</title>${tags.join('')}</head><body><h1>${title}</h1>${text}</body></html>`;
}

export const linkCardHeaders: Record<string, string> = {
	'content-type': 'text/html; charset=utf-8',
	'content-security-policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
	'x-content-type-options': 'nosniff',
	'referrer-policy': 'no-referrer',
	'x-robots-tag': 'noindex',
	'cache-control': 'no-store',
	vary: 'User-Agent'
};
