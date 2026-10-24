// SPDX-License-Identifier: AGPL-3.0-only
// Pages: a profile with blocks (buttons, headers, social links, and the extras), its theme, and
// the input rules that the API, the dashboard, and the MCP tools share.
import { LinkInputError, isBlockReason, parseLinkTime, type BlockReason } from './links';

export class PageInputError extends LinkInputError {}

// 3 to 30 lowercase letters, digits, and single hyphens, not at the start or end. No double
// hyphen, so no handle reads as a punycode label (xn--). Routing migration 0015 checks the same.
export const handlePattern = /^(?!.*--)[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$/;

// Words that would let a page pass for the service itself or for a host role. The operator keeps
// more in reserved_handles.
export const reservedHandles: readonly string[] = [
	'www',
	'app',
	'api',
	'admin',
	'administrator',
	'root',
	'mail',
	'email',
	'smtp',
	'imap',
	'pop',
	'ftp',
	'cdn',
	'static',
	'assets',
	'img',
	'images',
	'media',
	'files',
	'dns',
	'ns1',
	'ns2',
	'mx',
	'vpn',
	'dev',
	'staging',
	'test',
	'beta',
	'status',
	'support',
	'help',
	'docs',
	'blog',
	'news',
	'about',
	'contact',
	'abuse',
	'security',
	'privacy',
	'terms',
	'legal',
	'billing',
	'pay',
	'payment',
	'payments',
	'checkout',
	'account',
	'accounts',
	'login',
	'signin',
	'signup',
	'register',
	'auth',
	'oauth',
	'sso',
	'secure',
	'verify',
	'wallet',
	'bank',
	'official',
	'team',
	'flared',
	'flaredlink'
];

// Page addresses a workspace may ever hold, current and released together. Addresses are
// permanent, so this keeps one workspace from taking many of them by renaming.
export const maxPageHandles = 50;

export const maxPageTitleLength = 100;
export const maxPageBioLength = 300;
export const maxBlockLabelLength = 100;
export const maxPageBlocks = 100;
export const maxSocialLinks = 20;
export const maxPaymentDescriptionLength = 200;
export const maxPriceLength = 30;

export const pageFonts = ['figtree', 'sans', 'serif', 'mono'] as const;
export type PageFont = (typeof pageFonts)[number];
export const buttonShapes = ['square', 'rounded', 'pill'] as const;
export type ButtonShape = (typeof buttonShapes)[number];
export const buttonStyles = ['fill', 'outline'] as const;
export type ButtonStyle = (typeof buttonStyles)[number];

export interface ThemeValues {
	background: string;
	text: string;
	buttonBackground: string;
	buttonText: string;
	font: PageFont;
	buttonShape: ButtonShape;
	buttonStyle: ButtonStyle;
}

export interface ThemePreset extends ThemeValues {
	id: string;
	name: string;
}

// Every plan has every theme. The colour pairs keep at least 4.5:1 contrast.
export const themePresets: readonly ThemePreset[] = [
	{
		id: 'paper',
		name: 'Paper',
		background: '#f7f5f0',
		text: '#1c1b19',
		buttonBackground: '#1c1b19',
		buttonText: '#ffffff',
		font: 'figtree',
		buttonShape: 'rounded',
		buttonStyle: 'fill'
	},
	{
		id: 'ink',
		name: 'Ink',
		background: '#111111',
		text: '#f2f2f2',
		buttonBackground: '#f2f2f2',
		buttonText: '#111111',
		font: 'figtree',
		buttonShape: 'rounded',
		buttonStyle: 'fill'
	},
	{
		id: 'ember',
		name: 'Ember',
		background: '#fff1ec',
		text: '#3a1208',
		buttonBackground: '#b8360f',
		buttonText: '#ffffff',
		font: 'figtree',
		buttonShape: 'pill',
		buttonStyle: 'fill'
	},
	{
		id: 'forest',
		name: 'Forest',
		background: '#14281d',
		text: '#e8f3ec',
		buttonBackground: '#e8f3ec',
		buttonText: '#14281d',
		font: 'serif',
		buttonShape: 'rounded',
		buttonStyle: 'fill'
	},
	{
		id: 'ocean',
		name: 'Ocean',
		background: '#e8f1fb',
		text: '#0b2540',
		buttonBackground: '#0b4f8a',
		buttonText: '#ffffff',
		font: 'sans',
		buttonShape: 'pill',
		buttonStyle: 'fill'
	},
	{
		id: 'grape',
		name: 'Grape',
		background: '#2a1638',
		text: '#f4ecfa',
		buttonBackground: '#f4ecfa',
		buttonText: '#2a1638',
		font: 'figtree',
		buttonShape: 'pill',
		buttonStyle: 'outline'
	},
	{
		id: 'sun',
		name: 'Sun',
		background: '#fff6d6',
		text: '#2b2100',
		buttonBackground: '#2b2100',
		buttonText: '#fff6d6',
		font: 'sans',
		buttonShape: 'square',
		buttonStyle: 'fill'
	},
	{
		id: 'mint',
		name: 'Mint',
		background: '#e9f8f1',
		text: '#0d3324',
		buttonBackground: '#0d3324',
		buttonText: '#e9f8f1',
		font: 'figtree',
		buttonShape: 'rounded',
		buttonStyle: 'outline'
	},
	{
		id: 'slate',
		name: 'Slate',
		background: '#1e2530',
		text: '#e6ebf2',
		buttonBackground: '#3a4a60',
		buttonText: '#ffffff',
		font: 'sans',
		buttonShape: 'square',
		buttonStyle: 'fill'
	},
	{
		id: 'terminal',
		name: 'Terminal',
		background: '#0c0f0a',
		text: '#b9f5a6',
		buttonBackground: '#b9f5a6',
		buttonText: '#0c0f0a',
		font: 'mono',
		buttonShape: 'square',
		buttonStyle: 'outline'
	},
	{
		id: 'rose',
		name: 'Rose',
		background: '#fdeef3',
		text: '#3d0f22',
		buttonBackground: '#9c1f4f',
		buttonText: '#ffffff',
		font: 'serif',
		buttonShape: 'pill',
		buttonStyle: 'fill'
	},
	{
		id: 'newsprint',
		name: 'Newsprint',
		background: '#ffffff',
		text: '#111111',
		buttonBackground: '#111111',
		buttonText: '#ffffff',
		font: 'serif',
		buttonShape: 'square',
		buttonStyle: 'outline'
	}
];

export const defaultThemeId = 'paper';

// The stored theme: a preset and the member's changes to it.
export type PageTheme = { id: string } & Partial<ThemeValues>;

const colourPattern = /^#[0-9a-f]{6}$/;
const colourFields = ['background', 'text', 'buttonBackground', 'buttonText'] as const;

export function themePreset(id: string): ThemePreset | undefined {
	return themePresets.find((preset) => preset.id === id);
}

// The values a page shows: the preset, then the member's changes. An outline button draws its
// border and text in buttonBackground; buttonText colours the text of a filled button.
export function resolveTheme(theme: PageTheme): ThemeValues {
	const preset = themePreset(theme.id) ?? themePresets[0];
	return {
		background: theme.background ?? preset.background,
		text: theme.text ?? preset.text,
		buttonBackground: theme.buttonBackground ?? preset.buttonBackground,
		buttonText: theme.buttonText ?? preset.buttonText,
		font: theme.font ?? preset.font,
		buttonShape: theme.buttonShape ?? preset.buttonShape,
		buttonStyle: theme.buttonStyle ?? preset.buttonStyle
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown, field: string): Record<string, unknown> {
	if (!isRecord(value)) throw new PageInputError(field, 'Send a JSON object.');
	return value;
}

function onlyFields(body: Record<string, unknown>, allowed: readonly string[], field: string) {
	for (const key of Object.keys(body))
		if (!allowed.includes(key))
			throw new PageInputError(
				field === 'body' ? key : `${field}.${key}`,
				`Unknown field "${key}".`
			);
}

function oneOf<T extends string>(
	value: unknown,
	options: readonly T[],
	field: string,
	message: string
): T {
	if (typeof value !== 'string' || !(options as readonly string[]).includes(value))
		throw new PageInputError(field, message);
	return value as T;
}

export function parseTheme(value: unknown, field = 'theme'): PageTheme {
	if (value === undefined || value === null) return { id: defaultThemeId };
	const body = record(value, field);
	onlyFields(body, ['id', ...colourFields, 'font', 'buttonShape', 'buttonStyle'], field);
	const id = body.id;
	if (typeof id !== 'string' || !themePreset(id))
		throw new PageInputError(
			`${field}.id`,
			`Use a theme ID: ${themePresets.map((preset) => preset.id).join(', ')}.`
		);
	const theme: PageTheme = { id };
	for (const key of colourFields) {
		const colour = body[key];
		if (colour === undefined || colour === null) continue;
		if (typeof colour !== 'string' || !colourPattern.test(colour.toLowerCase()))
			throw new PageInputError(`${field}.${key}`, 'Use a colour such as #1c1b19.');
		theme[key] = colour.toLowerCase();
	}
	if (body.font !== undefined && body.font !== null)
		theme.font = oneOf(body.font, pageFonts, `${field}.font`, `Use ${pageFonts.join(', ')}.`);
	if (body.buttonShape !== undefined && body.buttonShape !== null)
		theme.buttonShape = oneOf(
			body.buttonShape,
			buttonShapes,
			`${field}.buttonShape`,
			`Use ${buttonShapes.join(', ')}.`
		);
	if (body.buttonStyle !== undefined && body.buttonStyle !== null)
		theme.buttonStyle = oneOf(
			body.buttonStyle,
			buttonStyles,
			`${field}.buttonStyle`,
			`Use ${buttonStyles.join(', ')}.`
		);
	return theme;
}

export function parseHandle(value: unknown): string {
	if (typeof value !== 'string' || !value.trim())
		throw new PageInputError('handle', 'Enter a page address.');
	const handle = value.trim().toLowerCase();
	if (!handlePattern.test(handle))
		throw new PageInputError(
			'handle',
			'Use 3 to 30 lowercase letters, digits, or single hyphens. Start and end with a letter or digit.'
		);
	if (reservedHandles.includes(handle))
		throw new PageInputError('handle', 'This page address is reserved.');
	return handle;
}

// Trimmed; empty is none. Line breaks are allowed only in the bio.
function parseText(
	value: unknown,
	field: string,
	max: number,
	label: string,
	lines = false
): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== 'string') throw new PageInputError(field, `Enter the ${label} as text.`);
	const text = value.trim();
	if (!text) return null;
	if (text.length > max)
		throw new PageInputError(field, `Use a ${label} of at most ${max} characters.`);
	const control = lines ? /(?!\n)\p{Cc}/u : /\p{Cc}/u;
	if (control.test(text)) throw new PageInputError(field, 'Remove control characters.');
	return text;
}

function requiredText(value: unknown, field: string, max: number, label: string): string {
	const text = parseText(value, field, max, label);
	if (text === null) throw new PageInputError(field, `Enter the ${label}.`);
	return text;
}

// Social networks, each with the hosts its profile addresses use, so a social icon cannot open
// another site. email takes an address and opens mail.
export const socialNetworks = {
	x: { name: 'X', hosts: ['x.com', 'twitter.com'] },
	instagram: { name: 'Instagram', hosts: ['instagram.com'] },
	tiktok: { name: 'TikTok', hosts: ['tiktok.com'] },
	youtube: { name: 'YouTube', hosts: ['youtube.com'] },
	facebook: { name: 'Facebook', hosts: ['facebook.com'] },
	linkedin: { name: 'LinkedIn', hosts: ['linkedin.com'] },
	github: { name: 'GitHub', hosts: ['github.com'] },
	threads: { name: 'Threads', hosts: ['threads.net', 'threads.com'] },
	bluesky: { name: 'Bluesky', hosts: ['bsky.app'] },
	twitch: { name: 'Twitch', hosts: ['twitch.tv'] },
	discord: { name: 'Discord', hosts: ['discord.gg', 'discord.com'] },
	whatsapp: { name: 'WhatsApp', hosts: ['wa.me', 'whatsapp.com'] },
	telegram: { name: 'Telegram', hosts: ['t.me', 'telegram.me'] },
	spotify: { name: 'Spotify', hosts: ['open.spotify.com'] },
	soundcloud: { name: 'SoundCloud', hosts: ['soundcloud.com'] },
	pinterest: { name: 'Pinterest', hosts: ['pinterest.com'] },
	snapchat: { name: 'Snapchat', hosts: ['snapchat.com'] },
	reddit: { name: 'Reddit', hosts: ['reddit.com'] },
	email: { name: 'Email', hosts: [] }
} as const satisfies Record<string, { name: string; hosts: readonly string[] }>;
export type SocialNetwork = keyof typeof socialNetworks;
const socialNetworkIds = Object.keys(socialNetworks) as SocialNetwork[];

// Payment providers and the hosts of their checkout pages. The buyer pays on the provider's own
// page; Flared never takes, holds, or reports money. A card shows only while its link still
// opens one of these hosts.
export const paymentProviders = {
	stripe: { name: 'Stripe', hosts: ['buy.stripe.com'] },
	polar: { name: 'Polar', hosts: ['buy.polar.sh', 'polar.sh'] },
	lemonsqueezy: { name: 'Lemon Squeezy', hosts: ['*.lemonsqueezy.com'] },
	gumroad: { name: 'Gumroad', hosts: ['gumroad.com', '*.gumroad.com'] }
} as const satisfies Record<string, { name: string; hosts: readonly string[] }>;
export type PaymentProvider = keyof typeof paymentProviders;
const paymentProviderIds = Object.keys(paymentProviders) as PaymentProvider[];

// A host matches an entry exactly, as www.<entry>, or, for *.<suffix>, as any subdomain.
export function hostMatches(hostname: string, hosts: readonly string[]): boolean {
	const host = hostname.toLowerCase();
	return hosts.some((entry) =>
		entry.startsWith('*.')
			? host.endsWith(entry.slice(1)) && host.length > entry.length - 1
			: host === entry || host === `www.${entry}`
	);
}

export function isPaymentDestination(provider: PaymentProvider, destination: string): boolean {
	try {
		const url = new URL(destination);
		return url.protocol === 'https:' && hostMatches(url.hostname, paymentProviders[provider].hosts);
	} catch {
		return false;
	}
}

// Embed providers. The page shows the provider's own player in a sandboxed iframe; src is built
// from the address the member pasted, never taken from it, and frame lists the CSP frame-src
// origin.
export const embedProviders = {
	youtube: { name: 'YouTube', frame: 'https://www.youtube-nocookie.com' },
	vimeo: { name: 'Vimeo', frame: 'https://player.vimeo.com' },
	spotify: { name: 'Spotify', frame: 'https://open.spotify.com' },
	applemusic: { name: 'Apple Music', frame: 'https://embed.music.apple.com' },
	soundcloud: { name: 'SoundCloud', frame: 'https://w.soundcloud.com' },
	calcom: { name: 'Cal.com', frame: 'https://cal.com' },
	calendly: { name: 'Calendly', frame: 'https://calendly.com' }
} as const satisfies Record<string, { name: string; frame: string }>;
export type EmbedProvider = keyof typeof embedProviders;
const embedProviderIds = Object.keys(embedProviders) as EmbedProvider[];

const youtubeId = /^[A-Za-z0-9_-]{11}$/;
const pathSegment = /^[A-Za-z0-9._~-]{1,100}$/;

// The player address for a pasted page address, or null when the address is not one the
// provider's player shows.
export function embedSource(provider: EmbedProvider, address: string): string | null {
	let url: URL;
	try {
		url = new URL(address);
	} catch {
		return null;
	}
	if (url.protocol !== 'https:' || url.username || url.password) return null;
	const host = url.hostname.toLowerCase();
	const parts = url.pathname.split('/').filter(Boolean);
	const plain = (segments: string[]) => segments.every((part) => pathSegment.test(part));
	switch (provider) {
		case 'youtube': {
			let id: string | null = null;
			if (host === 'youtu.be') id = parts[0] ?? null;
			else if (hostMatches(host, ['youtube.com', 'm.youtube.com'])) {
				if (parts[0] === 'watch') id = url.searchParams.get('v');
				else if (parts[0] === 'shorts' || parts[0] === 'live' || parts[0] === 'embed')
					id = parts[1] ?? null;
			}
			return id && youtubeId.test(id) ? `https://www.youtube-nocookie.com/embed/${id}` : null;
		}
		case 'vimeo': {
			const id = parts[0];
			return hostMatches(host, ['vimeo.com']) && id && /^\d{1,12}$/.test(id)
				? `https://player.vimeo.com/video/${id}?dnt=1`
				: null;
		}
		case 'spotify': {
			const kinds = ['track', 'album', 'playlist', 'episode', 'show', 'artist'];
			const [kind, id] = parts[0]?.startsWith('intl-') ? parts.slice(1) : parts;
			return host === 'open.spotify.com' &&
				kind &&
				kinds.includes(kind) &&
				id &&
				/^[A-Za-z0-9]{22}$/.test(id)
				? `https://open.spotify.com/embed/${kind}/${id}`
				: null;
		}
		case 'applemusic':
			return host === 'music.apple.com' && parts.length >= 2 && parts.length <= 5 && plain(parts)
				? `https://embed.music.apple.com/${parts.join('/')}${url.searchParams.has('i') && /^\d{1,15}$/.test(url.searchParams.get('i') ?? '') ? `?i=${url.searchParams.get('i')}` : ''}`
				: null;
		case 'soundcloud':
			return hostMatches(host, ['soundcloud.com']) &&
				parts.length >= 1 &&
				parts.length <= 3 &&
				plain(parts)
				? `https://w.soundcloud.com/player/?url=${encodeURIComponent(`https://soundcloud.com/${parts.join('/')}`)}`
				: null;
		case 'calcom':
			return host === 'cal.com' && parts.length >= 1 && parts.length <= 2 && plain(parts)
				? `https://cal.com/${parts.join('/')}/embed`
				: null;
		case 'calendly':
			return host === 'calendly.com' && parts.length >= 1 && parts.length <= 2 && plain(parts)
				? `https://calendly.com/${parts.join('/')}?embed_type=Inline&hide_gdpr_banner=1`
				: null;
	}
}

export interface SocialLink {
	network: SocialNetwork;
	// An https profile address on one of the network's hosts, or an email address for email.
	address: string;
}

// When a block shows: startsAt and endsAt in UTC milliseconds, null for no bound.
interface Schedule {
	startsAt: number | null;
	endsAt: number | null;
}

// The input form of a block. A button or a payment card opens a link of the workspace (linkId).
export type PageBlockInput = Schedule &
	(
		| { kind: 'button'; linkId: string; label: string }
		| { kind: 'header'; label: string }
		| { kind: 'social'; links: SocialLink[] }
		| {
				kind: 'payment';
				linkId: string;
				provider: PaymentProvider;
				label: string;
				price: string | null;
				description: string | null;
		  }
		| { kind: 'embed'; provider: EmbedProvider; address: string }
		| { kind: 'signup'; label: string; buttonLabel: string }
	);

export type PageBlockKind = PageBlockInput['kind'];

// The JSON form of a block in a request: times as ISO 8601 with Z or an offset, and a card's
// price and description optional.
type Optional = 'startsAt' | 'endsAt' | 'price' | 'description';
type WithTimes<T> = T extends unknown
	? Omit<T, Optional> &
			Partial<Pick<T, Extract<keyof T, 'price' | 'description'>>> & {
				startsAt?: string | null;
				endsAt?: string | null;
			}
	: never;
export type PageBlockBody = WithTimes<PageBlockInput>;
export const pageBlockKinds = ['button', 'header', 'social', 'payment', 'embed', 'signup'] as const;
// The kinds that need page extras on the plan.
export const extraBlockKinds: readonly PageBlockKind[] = ['payment', 'embed', 'signup'];

const emailPattern = /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{2,63}$/;

function parseSocialLink(value: unknown, field: string): SocialLink {
	const body = record(value, field);
	onlyFields(body, ['network', 'address'], field);
	const network = oneOf(
		body.network,
		socialNetworkIds,
		`${field}.network`,
		`Use a network: ${socialNetworkIds.join(', ')}.`
	);
	const address = body.address;
	if (typeof address !== 'string' || !address.trim() || address.length > 2048)
		throw new PageInputError(`${field}.address`, 'Enter the profile address.');
	const input = address.trim();
	if (network === 'email') {
		if (!emailPattern.test(input))
			throw new PageInputError(`${field}.address`, 'Enter an email address.');
		return { network, address: input };
	}
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		throw new PageInputError(`${field}.address`, 'Enter a full address that starts with https://.');
	}
	if (url.protocol !== 'https:' || url.username || url.password)
		throw new PageInputError(`${field}.address`, 'Use an https address.');
	if (!hostMatches(url.hostname, socialNetworks[network].hosts))
		throw new PageInputError(
			`${field}.address`,
			`Use a ${socialNetworks[network].name} address (${socialNetworks[network].hosts.join(' or ')}).`
		);
	return { network, address: url.href };
}

function parseLinkId(value: unknown, field: string): string {
	if (typeof value !== 'string' || !value || value.length > 64)
		throw new PageInputError(field, 'Use a link ID from GET /v1/links.');
	return value;
}

export function parsePageBlock(value: unknown, index: number): PageBlockInput {
	const field = `blocks.${index}`;
	const body = record(value, field);
	const kind = oneOf(
		body.kind,
		pageBlockKinds,
		`${field}.kind`,
		`Use a block kind: ${pageBlockKinds.join(', ')}.`
	);
	const fields: Record<PageBlockKind, readonly string[]> = {
		button: ['linkId', 'label'],
		header: ['label'],
		social: ['links'],
		payment: ['linkId', 'provider', 'label', 'price', 'description'],
		embed: ['provider', 'address'],
		signup: ['label', 'buttonLabel']
	};
	onlyFields(body, ['kind', 'startsAt', 'endsAt', ...fields[kind]], field);
	const schedule: Schedule = {
		startsAt: parseScheduleTime(body.startsAt, `${field}.startsAt`),
		endsAt: parseScheduleTime(body.endsAt, `${field}.endsAt`)
	};
	if (
		schedule.startsAt !== null &&
		schedule.endsAt !== null &&
		schedule.endsAt <= schedule.startsAt
	)
		throw new PageInputError(`${field}.endsAt`, 'Set the end after the start.');
	const label = (max = maxBlockLabelLength) =>
		requiredText(body.label, `${field}.label`, max, 'label');
	switch (kind) {
		case 'button':
			return {
				kind,
				linkId: parseLinkId(body.linkId, `${field}.linkId`),
				label: label(),
				...schedule
			};
		case 'header':
			return { kind, label: label(), ...schedule };
		case 'social': {
			if (!Array.isArray(body.links) || body.links.length === 0)
				throw new PageInputError(`${field}.links`, 'Add at least one social link.');
			if (body.links.length > maxSocialLinks)
				throw new PageInputError(
					`${field}.links`,
					`Add at most ${maxSocialLinks} social links to one block.`
				);
			const links = body.links.map((item, position) =>
				parseSocialLink(item, `${field}.links.${position}`)
			);
			return { kind, links, ...schedule };
		}
		case 'payment':
			return {
				kind,
				linkId: parseLinkId(body.linkId, `${field}.linkId`),
				provider: oneOf(
					body.provider,
					paymentProviderIds,
					`${field}.provider`,
					`Use a provider: ${paymentProviderIds.join(', ')}.`
				),
				label: label(),
				price: parseText(body.price, `${field}.price`, maxPriceLength, 'price'),
				description: parseText(
					body.description,
					`${field}.description`,
					maxPaymentDescriptionLength,
					'description'
				),
				...schedule
			};
		case 'embed': {
			const provider = oneOf(
				body.provider,
				embedProviderIds,
				`${field}.provider`,
				`Use a provider: ${embedProviderIds.join(', ')}.`
			);
			const address = typeof body.address === 'string' ? body.address.trim() : '';
			if (!address || address.length > 2048 || embedSource(provider, address) === null)
				throw new PageInputError(
					`${field}.address`,
					`Paste the address of a ${embedProviders[provider].name} page that can be embedded.`
				);
			return { kind, provider, address: new URL(address).href, ...schedule };
		}
		case 'signup':
			return {
				kind,
				label: label(),
				buttonLabel: requiredText(body.buttonLabel, `${field}.buttonLabel`, 40, 'button label'),
				...schedule
			};
	}
}

function parseScheduleTime(value: unknown, field: string): number | null {
	try {
		return parseLinkTime(value, 'startsAt');
	} catch (error) {
		if (error instanceof LinkInputError) throw new PageInputError(field, error.message);
		throw error;
	}
}

export function parseBlocks(value: unknown): PageBlockInput[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) throw new PageInputError('blocks', 'Send blocks as a list.');
	if (value.length > maxPageBlocks)
		throw new PageInputError('blocks', `Add at most ${maxPageBlocks} blocks to one page.`);
	return value.map((item, index) => parsePageBlock(item, index));
}

export interface CreatePageInput {
	handle: string;
	title: string;
	bio: string | null;
	theme: PageTheme;
	blocks: PageBlockInput[];
	domainId: string | null;
}

// The JSON bodies of POST /v1/pages and PATCH /v1/pages/{id}.
export interface CreatePageBody {
	handle: string;
	title: string;
	bio?: string | null;
	theme?: PageTheme;
	blocks?: PageBlockBody[];
	domainId?: string | null;
}

export type UpdatePageBody = Partial<Omit<CreatePageBody, 'title' | 'handle'>> & {
	handle?: string;
	title?: string;
	enabled?: boolean;
};

// undefined keeps a field; null clears the bio or the domain. blocks replaces the whole list.
export interface UpdatePageInput {
	handle?: string;
	title?: string;
	bio?: string | null;
	theme?: PageTheme;
	blocks?: PageBlockInput[];
	domainId?: string | null;
	enabled?: boolean;
}

function parseDomainId(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== 'string' || !value || value.length > 64)
		throw new PageInputError('domainId', 'Use a domain ID from GET /v1/domains.');
	return value;
}

const pageFields = ['handle', 'title', 'bio', 'theme', 'blocks', 'domainId'] as const;

export function parseCreatePage(value: unknown): CreatePageInput {
	const body = record(value, 'body');
	onlyFields(body, pageFields, 'body');
	return {
		handle: parseHandle(body.handle),
		title: requiredText(body.title, 'title', maxPageTitleLength, 'title'),
		bio: parseText(body.bio, 'bio', maxPageBioLength, 'bio', true),
		theme: parseTheme(body.theme),
		blocks: parseBlocks(body.blocks),
		domainId: parseDomainId(body.domainId)
	};
}

export function parseUpdatePage(value: unknown): UpdatePageInput {
	const body = record(value, 'body');
	onlyFields(body, [...pageFields, 'enabled'], 'body');
	const update: UpdatePageInput = {};
	if (body.handle !== undefined) update.handle = parseHandle(body.handle);
	if (body.title !== undefined)
		update.title = requiredText(body.title, 'title', maxPageTitleLength, 'title');
	if (body.bio !== undefined)
		update.bio = parseText(body.bio, 'bio', maxPageBioLength, 'bio', true);
	if (body.theme !== undefined) update.theme = parseTheme(body.theme);
	if (body.blocks !== undefined) update.blocks = parseBlocks(body.blocks);
	if (body.domainId !== undefined) update.domainId = parseDomainId(body.domainId);
	if (body.enabled !== undefined) {
		if (typeof body.enabled !== 'boolean')
			throw new PageInputError('enabled', 'Use true or false.');
		update.enabled = body.enabled;
	}
	if (Object.keys(update).length === 0)
		throw new PageInputError(
			'body',
			'Change the address, title, bio, theme, blocks, domain, or the enabled state.'
		);
	return update;
}

// Whether the input needs page extras: an extra block kind or a workspace domain. Clearing the
// domain never needs them.
export function usesPageExtras(input: Partial<CreatePageInput> | UpdatePageInput): boolean {
	return (
		(input.domainId !== undefined && input.domainId !== null) ||
		(input.blocks ?? []).some((block) => extraBlockKinds.includes(block.kind))
	);
}

// The read form of a block. A button and a payment card carry their link's short URL; a link
// that is off, blocked, or no longer on the provider's checkout keeps the block hidden on the page
// (visible is false).
export type PageBlock = (
	| { kind: 'button'; linkId: string; label: string; shortUrl: string }
	| { kind: 'header'; label: string }
	| { kind: 'social'; links: SocialLink[] }
	| {
			kind: 'payment';
			linkId: string;
			provider: PaymentProvider;
			label: string;
			price: string | null;
			description: string | null;
			shortUrl: string;
	  }
	| { kind: 'embed'; provider: EmbedProvider; address: string }
	| { kind: 'signup'; label: string; buttonLabel: string }
) & { startsAt: string | null; endsAt: string | null; visible: boolean };

export interface Page {
	id: string;
	handle: string;
	// Where the page shows: <handle> on the page host, or null when this installation has none.
	url: string | null;
	// The workspace domain whose root shows the page, and that address.
	domainId: string | null;
	domainUrl: string | null;
	title: string;
	bio: string | null;
	avatarImage: string | null;
	backgroundImage: string | null;
	theme: PageTheme;
	blocks: PageBlock[];
	enabled: boolean;
	// Set while the operator blocks the page for abuse. A blocked page does not show, and its
	// owner cannot edit it or turn it on.
	blocked: { reason: BlockReason } | null;
	createdAt: string;
	updatedAt: string;
}

export interface PageSummary {
	id: string;
	handle: string;
	url: string | null;
	domainUrl: string | null;
	title: string;
	enabled: boolean;
	blocked: { reason: BlockReason } | null;
	createdAt: string;
	updatedAt: string;
}

export interface PageList {
	pages: PageSummary[];
	nextCursor: string | null;
}

export function isPageSummary(value: unknown): value is PageSummary {
	if (!isRecord(value)) return false;
	const blocked = value.blocked;
	return (
		typeof value.id === 'string' &&
		typeof value.handle === 'string' &&
		(value.url === null || typeof value.url === 'string') &&
		(value.domainUrl === null || typeof value.domainUrl === 'string') &&
		typeof value.title === 'string' &&
		typeof value.enabled === 'boolean' &&
		(blocked === null || (isRecord(blocked) && isBlockReason(blocked.reason))) &&
		typeof value.createdAt === 'string' &&
		typeof value.updatedAt === 'string'
	);
}

export function isPageList(value: unknown): value is PageList {
	return (
		isRecord(value) &&
		Array.isArray(value.pages) &&
		value.pages.every(isPageSummary) &&
		(value.nextCursor === null || typeof value.nextCursor === 'string')
	);
}

export function isPage(value: unknown): value is Page {
	return (
		isPageSummary(value) &&
		isRecord(value) &&
		Array.isArray(value.blocks) &&
		value.blocks.every(
			(block) =>
				isRecord(block) &&
				(pageBlockKinds as readonly unknown[]).includes(block.kind) &&
				typeof block.visible === 'boolean'
		) &&
		isRecord(value.theme) &&
		typeof value.theme.id === 'string'
	);
}
