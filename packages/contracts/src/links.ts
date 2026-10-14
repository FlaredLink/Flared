// SPDX-License-Identifier: AGPL-3.0-only
import { isReservedSlug } from './reserved';

export const slugPattern = /^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])$/;
export const maxDestinationLength = 4096;
export const maxTitleLength = 200;
export const maxIdempotencyKeyLength = 255;

// Abuse categories for an operator block or suspension. The owner sees the category only.
export const blockReasons = ['phishing', 'malware', 'spam', 'illegal', 'other'] as const;
export type BlockReason = (typeof blockReasons)[number];

export function isBlockReason(value: unknown): value is BlockReason {
	return typeof value === 'string' && (blockReasons as readonly string[]).includes(value);
}

export interface Link {
	id: string;
	domainId: string;
	hostname: string;
	slug: string;
	shortUrl: string;
	destination: string;
	title: string | null;
	// Where iPhone and Android visitors go instead of destination. Servers before device
	// destinations were added leave them out.
	iosDestination?: string | null;
	androidDestination?: string | null;
	enabled: boolean;
	// Set while the operator blocks the link for abuse. A blocked link does not redirect, and
	// its owner cannot edit it or turn it on.
	blocked: { reason: BlockReason } | null;
	createdAt: string;
	updatedAt: string;
}

// A listed link also carries its clicks in the last 30 UTC days, or null when analytics are
// not available at the moment. dailyClicksLast30Days has one count for each of those days,
// oldest first, ending today; servers before it was added leave it out.
export interface ListedLink extends Link {
	clicksLast30Days: number | null;
	dailyClicksLast30Days?: number[] | null;
}

export const recentClickDays = 30;

export interface LinkPage {
	links: ListedLink[];
	nextCursor: string | null;
}

export interface CreateLinkInput {
	destination: string;
	slug: string | null;
	title: string | null;
	domainId: string | null;
	iosDestination: string | null;
	androidDestination: string | null;
}

// null clears a device destination.
export interface UpdateLinkInput {
	destination?: string;
	title?: string | null;
	iosDestination?: string | null;
	androidDestination?: string | null;
	enabled?: boolean;
}

export type DeviceField = 'iosDestination' | 'androidDestination';

export class LinkInputError extends Error {
	constructor(
		readonly field: string,
		message: string
	) {
		super(message);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
	if (!isRecord(value)) throw new LinkInputError('body', 'Send a JSON object.');
	return value;
}

function onlyFields(body: Record<string, unknown>, allowed: string[]): void {
	for (const key of Object.keys(body))
		if (!allowed.includes(key)) throw new LinkInputError(key, `Unknown field "${key}".`);
}

export function parseDestination(value: unknown, field = 'destination'): string {
	if (typeof value !== 'string' || !value.trim())
		throw new LinkInputError(field, 'Enter a destination URL.');
	const input = value.trim();
	if (input.length > maxDestinationLength)
		throw new LinkInputError(field, 'Use a destination of at most 4,096 characters.');
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		throw new LinkInputError(field, 'Enter a full URL that starts with https://.');
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:')
		throw new LinkInputError(field, 'Use an http or https URL.');
	if (url.username || url.password)
		throw new LinkInputError(field, 'Remove the user name or password from the URL.');
	if (!url.hostname) throw new LinkInputError(field, 'Enter a URL with a host name.');
	if (url.href.length > maxDestinationLength)
		throw new LinkInputError(field, 'Use a destination of at most 4,096 characters.');
	return url.href;
}

// Schemes that run code, read local data, or open browser or OS internals. A device destination
// never uses them, even in the scheme://... form. App schemes cannot be listed in advance, so
// whole families are refused: browser vendor prefixes, every extension scheme, and Windows ms-*
// protocol handlers.
const refusedSchemes = new Set([
	'javascript',
	'data',
	'vbscript',
	'file',
	'blob',
	'filesystem',
	'about',
	'jar',
	'ws',
	'wss',
	'ftp',
	'shell',
	'search-ms',
	// Old script aliases and browser internals.
	'livescript',
	'mocha',
	'devtools',
	'wyciwyg',
	// App installs outside a store, and local Android data.
	'itms-services',
	'cydia',
	'sideloadly',
	'content',
	// Network protocols that can send credentials.
	'smb',
	'ldap',
	'ldaps',
	'telnet',
	'gopher',
	'ssh',
	'ssl'
]);
const refusedSchemeFamilies =
	/^(?:chrome|edge|opera|brave|vivaldi|firefox|moz|ms|safari|webkit|resource|res|view-source)(?:[-+.]|$)|-extension$/;

function isRefusedScheme(scheme: string): boolean {
	return refusedSchemes.has(scheme) || refusedSchemeFamilies.test(scheme);
}
const appSchemePattern = /^([a-z][a-z0-9+.-]{0,63}):\/\/\S+$/i;

// A device destination: an http(s) URL with the destination rules, or an app link in the
// scheme://... form. intent:// is an Android form. An empty value is no device destination.
export function parseDeviceDestination(value: unknown, field: DeviceField): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== 'string') throw new LinkInputError(field, 'Enter the app link as text.');
	const input = value.trim();
	if (!input) return null;
	if (/^https?:/i.test(input)) return parseDestination(input, field);
	if (input.length > maxDestinationLength)
		throw new LinkInputError(field, 'Use an app link of at most 4,096 characters.');
	const scheme = appSchemePattern.exec(input)?.[1]?.toLowerCase();
	if (!scheme)
		throw new LinkInputError(field, 'Enter an https URL or an app link such as myapp://path.');
	if (/\p{Cc}/u.test(input)) throw new LinkInputError(field, 'Remove control characters.');
	if (isRefusedScheme(scheme))
		throw new LinkInputError(field, `The ${scheme} scheme is not allowed.`);
	if (scheme === 'intent' && field !== 'androidDestination')
		throw new LinkInputError(field, 'Use intent:// links for Android only.');
	return input;
}

export const utmKeys = ['source', 'medium', 'campaign', 'term', 'content'] as const;
export type UtmKey = (typeof utmKeys)[number];
export type Utm = Partial<Record<UtmKey, string>>;
export const maxUtmLength = 200;

// The utm_* values of a URL, for a form that edits them.
export function utmOf(destination: string): Utm {
	const utm: Utm = {};
	try {
		const params = new URL(destination).searchParams;
		for (const key of utmKeys) {
			const value = params.get(`utm_${key}`);
			if (value !== null) utm[key] = value;
		}
	} catch {
		// Not a URL yet: no values to show.
	}
	return utm;
}

export function parseUtm(value: unknown): Utm {
	if (value === undefined || value === null) return {};
	if (typeof value !== 'object' || Array.isArray(value))
		throw new LinkInputError('utm', 'Send UTM values as an object.');
	const utm: Utm = {};
	for (const [key, item] of Object.entries(value)) {
		if (!(utmKeys as readonly string[]).includes(key))
			throw new LinkInputError('utm', `Unknown UTM field "${key}".`);
		if (typeof item !== 'string') throw new LinkInputError('utm', `Enter utm_${key} as text.`);
		if (item.length > maxUtmLength)
			throw new LinkInputError('utm', `Use at most 200 characters for utm_${key}.`);
		if (/\p{Cc}/u.test(item)) throw new LinkInputError('utm', 'Remove control characters.');
		utm[key as UtmKey] = item.trim();
	}
	return utm;
}

// Sets each given utm_* parameter on the destination; an empty value removes it. Keys that are
// not given stay as they are. The result goes through parseDestination.
export function withUtm(destination: string, utm: Utm): string {
	const url = new URL(parseDestination(destination));
	for (const key of utmKeys) {
		const value = utm[key];
		if (value === undefined) continue;
		if (value) url.searchParams.set(`utm_${key}`, value);
		else url.searchParams.delete(`utm_${key}`);
	}
	return parseDestination(url.href);
}

export function parseSlug(value: unknown): string | null {
	if (value === undefined || value === null || value === '') return null;
	if (typeof value !== 'string') throw new LinkInputError('slug', 'Enter the slug as text.');
	if (!slugPattern.test(value))
		throw new LinkInputError(
			'slug',
			'Use 3 to 64 lowercase letters, digits, or hyphens. Start and end with a letter or digit.'
		);
	if (isReservedSlug(value)) throw new LinkInputError('slug', 'This slug is reserved.');
	return value;
}

export function parseTitle(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== 'string') throw new LinkInputError('title', 'Enter the title as text.');
	const title = value.trim();
	if (!title) return null;
	if (title.length > maxTitleLength)
		throw new LinkInputError('title', 'Use a title of at most 200 characters.');
	// Control characters break list rendering and logs.
	if (/\p{Cc}/u.test(title)) throw new LinkInputError('title', 'Remove control characters.');
	return title;
}

export function parseCreateLink(value: unknown): CreateLinkInput {
	const body = record(value);
	onlyFields(body, [
		'destination',
		'slug',
		'title',
		'domainId',
		'iosDestination',
		'androidDestination'
	]);
	const domainId = body.domainId;
	if (domainId !== undefined && domainId !== null && (typeof domainId !== 'string' || !domainId))
		throw new LinkInputError('domainId', 'Use a domain ID from GET /v1/domains.');
	return {
		destination: parseDestination(body.destination),
		slug: parseSlug(body.slug),
		title: parseTitle(body.title),
		domainId: typeof domainId === 'string' ? domainId : null,
		iosDestination: parseDeviceDestination(body.iosDestination, 'iosDestination'),
		androidDestination: parseDeviceDestination(body.androidDestination, 'androidDestination')
	};
}

export function parseUpdateLink(value: unknown): UpdateLinkInput {
	const body = record(value);
	onlyFields(body, ['destination', 'title', 'iosDestination', 'androidDestination', 'enabled']);
	const update: UpdateLinkInput = {};
	if (body.destination !== undefined) update.destination = parseDestination(body.destination);
	if (body.title !== undefined) update.title = parseTitle(body.title);
	for (const field of ['iosDestination', 'androidDestination'] as const)
		if (body[field] !== undefined) update[field] = parseDeviceDestination(body[field], field);
	if (body.enabled !== undefined) {
		if (typeof body.enabled !== 'boolean')
			throw new LinkInputError('enabled', 'Use true or false.');
		update.enabled = body.enabled;
	}
	if (Object.keys(update).length === 0)
		throw new LinkInputError(
			'body',
			'Change the destination, title, a device destination, or the enabled state.'
		);
	return update;
}

// Printable ASCII only, so the key is safe to store and compare.
export function parseIdempotencyKey(value: string | null): string | null {
	if (value === null) return null;
	if (!value || value.length > maxIdempotencyKeyLength || !/^[\x21-\x7e]+$/.test(value))
		return null;
	return value;
}

const isOptionalText = (value: unknown) =>
	value === undefined || value === null || typeof value === 'string';

// Shape checks for API responses read by clients.
export function isLink(value: unknown): value is Link {
	if (!isRecord(value)) return false;
	return (
		typeof value.id === 'string' &&
		typeof value.domainId === 'string' &&
		typeof value.hostname === 'string' &&
		typeof value.slug === 'string' &&
		typeof value.shortUrl === 'string' &&
		typeof value.destination === 'string' &&
		(value.title === null || typeof value.title === 'string') &&
		isOptionalText(value.iosDestination) &&
		isOptionalText(value.androidDestination) &&
		typeof value.enabled === 'boolean' &&
		typeof value.createdAt === 'string' &&
		typeof value.updatedAt === 'string'
	);
}

function isListedLink(value: unknown): value is ListedLink {
	if (!isRecord(value) || !isLink(value)) return false;
	const isCount = (item: unknown) => Number.isSafeInteger(item) && (item as number) >= 0;
	const clicks: unknown = value.clicksLast30Days;
	const daily: unknown = value.dailyClicksLast30Days;
	return (
		(clicks === null || isCount(clicks)) &&
		(daily === undefined ||
			daily === null ||
			(Array.isArray(daily) && daily.length === recentClickDays && daily.every(isCount)))
	);
}

export function isLinkPage(value: unknown): value is LinkPage {
	return (
		isRecord(value) &&
		Array.isArray(value.links) &&
		value.links.every(isListedLink) &&
		(value.nextCursor === null || typeof value.nextCursor === 'string')
	);
}
