// SPDX-License-Identifier: AGPL-3.0-only
import { isErrorCode, type ErrorCode } from './errors';
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
	// The link opens at startsAt and stops at endsAt (ISO 8601, UTC); null is no bound. After the
	// end, visitors go to endedDestination, or see that the link has ended. hasPassword: visitors
	// enter a password first; the password itself is never returned. Servers before link access
	// was added leave them out.
	startsAt?: string | null;
	endsAt?: string | null;
	endedDestination?: string | null;
	hasPassword?: boolean;
	// What card bots, such as Slack, X, and LinkedIn, show for the link instead of the
	// destination's own tags. previewImage is the image's URL on the short-link host. Servers
	// before social previews were added leave them out.
	previewTitle?: string | null;
	previewDescription?: string | null;
	previewImage?: string | null;
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
	// UTC milliseconds.
	startsAt: number | null;
	endsAt: number | null;
	endedDestination: string | null;
	password: string | null;
	previewTitle: string | null;
	previewDescription: string | null;
}

// null clears a device destination, a date, the destination after the end, the password, or a
// preview text.
export interface UpdateLinkInput {
	destination?: string;
	title?: string | null;
	iosDestination?: string | null;
	androidDestination?: string | null;
	startsAt?: number | null;
	endsAt?: number | null;
	endedDestination?: string | null;
	password?: string | null;
	previewTitle?: string | null;
	previewDescription?: string | null;
	enabled?: boolean;
}

// The fields that need link access on the plan. Setting one needs it; clearing one does not.
export const linkAccessFields = ['startsAt', 'endsAt', 'endedDestination', 'password'] as const;

export function setsLinkAccess(input: Partial<CreateLinkInput> | UpdateLinkInput): boolean {
	return linkAccessFields.some((field) => input[field] !== undefined && input[field] !== null);
}

// The fields that need social previews on the plan. Setting one needs them; clearing one does
// not. The image has its own route.
export const linkPreviewFields = ['previewTitle', 'previewDescription'] as const;

export function setsLinkPreview(input: Partial<CreateLinkInput> | UpdateLinkInput): boolean {
	return linkPreviewFields.some((field) => input[field] !== undefined && input[field] !== null);
}

export const maxPreviewTitleLength = 200;
export const maxPreviewDescriptionLength = 500;
// An uploaded preview image: PNG, JPEG, or WebP, at most 5 MB. Card sites show 1200 x 630 best.
export const maxPreviewImageBytes = 5 * 1024 * 1024;
export const previewImageTypes = {
	png: 'image/png',
	jpg: 'image/jpeg',
	webp: 'image/webp'
} as const;
export type PreviewImageExtension = keyof typeof previewImageTypes;
// The stored name of an image: 16 random bytes in base64url and the extension.
export const previewImageFilePattern = /^[A-Za-z0-9_-]{22}\.(?:png|jpg|webp)$/;

// The type comes from the first bytes, never from the upload's content type.
export function sniffPreviewImage(bytes: Uint8Array): PreviewImageExtension | null {
	const starts = (...values: number[]) => values.every((value, index) => bytes[index] === value);
	if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'png';
	if (starts(0xff, 0xd8, 0xff)) return 'jpg';
	if (starts(0x52, 0x49, 0x46, 0x46) && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP')
		return 'webp';
	return null;
}

// The path of a link's preview image on its short-link host. A new image gets a new name, so
// card sites that keep the old image fetch the new one.
export function previewImagePath(slug: string, file: string): string {
	return `/${slug}/preview/${file}`;
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

export const minLinkPasswordLength = 4;
export const maxLinkPasswordLength = 128;
// The latest time a date may name: the end of year 9999.
const maxTime = 253402300799999;
const timePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

// An ISO 8601 date and time with Z or an offset, so the moment does not depend on the server's
// time zone. Returns UTC milliseconds; an empty value is no date.
export function parseLinkTime(value: unknown, field: 'startsAt' | 'endsAt'): number | null {
	if (value === undefined || value === null || value === '') return null;
	if (typeof value !== 'string' || !timePattern.test(value))
		throw new LinkInputError(
			field,
			'Enter a date and time with a time zone, such as 2026-11-01T09:00:00Z.'
		);
	const time = Date.parse(value);
	if (!Number.isSafeInteger(time) || time < 0 || time > maxTime)
		throw new LinkInputError(field, 'Enter a real date and time.');
	return time;
}

// Kept as typed: spaces count, so only control characters are refused.
export function parseLinkPassword(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== 'string')
		throw new LinkInputError('password', 'Enter the password as text.');
	if (value.length < minLinkPasswordLength || value.length > maxLinkPasswordLength)
		throw new LinkInputError('password', 'Use a password of 4 to 128 characters.');
	if (/\p{Cc}/u.test(value)) throw new LinkInputError('password', 'Remove control characters.');
	return value;
}

function parseEndedDestination(value: unknown): string | null {
	if (value === undefined || value === null || value === '') return null;
	return parseDestination(value, 'endedDestination');
}

// Both dates of one request, in order. The server checks a change against the stored dates too.
export function checkLinkWindow(window: {
	startsAt: number | null;
	endsAt: number | null;
	endedDestination: string | null;
}): void {
	if (window.startsAt !== null && window.endsAt !== null && window.endsAt <= window.startsAt)
		throw new LinkInputError('endsAt', 'Set the end after the start.');
	if (window.endedDestination !== null && window.endsAt === null)
		throw new LinkInputError('endedDestination', 'Set an end date for this destination.');
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

// Trimmed; empty is none. Line breaks are refused like other control characters, because cards
// show one paragraph.
export function parsePreviewText(
	value: unknown,
	field: (typeof linkPreviewFields)[number]
): string | null {
	if (value === undefined || value === null) return null;
	const label = field === 'previewTitle' ? 'title' : 'description';
	const max = field === 'previewTitle' ? maxPreviewTitleLength : maxPreviewDescriptionLength;
	if (typeof value !== 'string') throw new LinkInputError(field, `Enter the ${label} as text.`);
	const text = value.trim();
	if (!text) return null;
	if (text.length > max)
		throw new LinkInputError(field, `Use a ${label} of at most ${max} characters.`);
	if (/\p{Cc}/u.test(text)) throw new LinkInputError(field, 'Remove control characters.');
	return text;
}

export function parseCreateLink(value: unknown): CreateLinkInput {
	const body = record(value);
	onlyFields(body, [
		'destination',
		'slug',
		'title',
		'domainId',
		'iosDestination',
		'androidDestination',
		'startsAt',
		'endsAt',
		'endedDestination',
		'password',
		'previewTitle',
		'previewDescription'
	]);
	const domainId = body.domainId;
	if (domainId !== undefined && domainId !== null && (typeof domainId !== 'string' || !domainId))
		throw new LinkInputError('domainId', 'Use a domain ID from GET /v1/domains.');
	const input: CreateLinkInput = {
		destination: parseDestination(body.destination),
		slug: parseSlug(body.slug),
		title: parseTitle(body.title),
		domainId: typeof domainId === 'string' ? domainId : null,
		iosDestination: parseDeviceDestination(body.iosDestination, 'iosDestination'),
		androidDestination: parseDeviceDestination(body.androidDestination, 'androidDestination'),
		startsAt: parseLinkTime(body.startsAt, 'startsAt'),
		endsAt: parseLinkTime(body.endsAt, 'endsAt'),
		endedDestination: parseEndedDestination(body.endedDestination),
		password: parseLinkPassword(body.password),
		previewTitle: parsePreviewText(body.previewTitle, 'previewTitle'),
		previewDescription: parsePreviewText(body.previewDescription, 'previewDescription')
	};
	checkLinkWindow(input);
	return input;
}

export function parseUpdateLink(value: unknown): UpdateLinkInput {
	const body = record(value);
	onlyFields(body, [
		'destination',
		'title',
		'iosDestination',
		'androidDestination',
		'startsAt',
		'endsAt',
		'endedDestination',
		'password',
		'previewTitle',
		'previewDescription',
		'enabled'
	]);
	const update: UpdateLinkInput = {};
	if (body.destination !== undefined) update.destination = parseDestination(body.destination);
	if (body.title !== undefined) update.title = parseTitle(body.title);
	for (const field of ['iosDestination', 'androidDestination'] as const)
		if (body[field] !== undefined) update[field] = parseDeviceDestination(body[field], field);
	for (const field of ['startsAt', 'endsAt'] as const)
		if (body[field] !== undefined) update[field] = parseLinkTime(body[field], field);
	if (body.endedDestination !== undefined)
		update.endedDestination = parseEndedDestination(body.endedDestination);
	if (body.password !== undefined) update.password = parseLinkPassword(body.password);
	for (const field of linkPreviewFields)
		if (body[field] !== undefined) update[field] = parsePreviewText(body[field], field);
	if (body.enabled !== undefined) {
		if (typeof body.enabled !== 'boolean')
			throw new LinkInputError('enabled', 'Use true or false.');
		update.enabled = body.enabled;
	}
	if (Object.keys(update).length === 0)
		throw new LinkInputError(
			'body',
			'Change the destination, title, a device destination, a date, the password, a preview text, or the enabled state.'
		);
	if (update.startsAt !== undefined && update.endsAt !== undefined)
		checkLinkWindow({
			startsAt: update.startsAt,
			endsAt: update.endsAt,
			endedDestination: update.endedDestination ?? null
		});
	return update;
}

// A bulk import. Each item has the fields of a create request and is checked on its own, so an
// invalid item fails alone; only a malformed request as a whole is refused.
export interface ImportLinksRequest {
	dryRun: boolean;
	items: unknown[];
}

// ready: a dry run found nothing that stops the item. created: a real run created the link, or a
// replay returned it. failed: error says why; nothing was created for the item.
export type ImportItemStatus = 'ready' | 'created' | 'failed';

export interface ImportItemError {
	code: ErrorCode;
	message: string;
	field?: string;
}

export interface ImportItemResult {
	index: number;
	status: ImportItemStatus;
	link?: Link;
	error?: ImportItemError;
}

// summary has ready and failed for a dry run, created and failed for a real run.
export interface ImportLinksResult {
	dryRun: boolean;
	results: ImportItemResult[];
	summary: { ready: number; failed: number } | { created: number; failed: number };
}

export class ImportRequestError extends Error {
	constructor(
		readonly code: Extract<ErrorCode, 'INVALID_IMPORT' | 'TOO_MANY_ITEMS'>,
		readonly field: string,
		message: string
	) {
		super(message);
	}
}

// The request shape only; parseCreateLink checks each item.
export function parseImportRequest(value: unknown, maxItems: number): ImportLinksRequest {
	if (!isRecord(value))
		throw new ImportRequestError('INVALID_IMPORT', 'body', 'Send a JSON object.');
	for (const key of Object.keys(value))
		if (key !== 'dryRun' && key !== 'items')
			throw new ImportRequestError('INVALID_IMPORT', key, `Unknown field "${key}".`);
	if (typeof value.dryRun !== 'boolean')
		throw new ImportRequestError('INVALID_IMPORT', 'dryRun', 'Set dryRun to true or false.');
	if (!Array.isArray(value.items) || value.items.length === 0)
		throw new ImportRequestError('INVALID_IMPORT', 'items', 'Send items as a list of links.');
	if (value.items.length > maxItems)
		throw new ImportRequestError(
			'TOO_MANY_ITEMS',
			'items',
			`Send at most ${maxItems} items in one request.`
		);
	return { dryRun: value.dryRun, items: value.items };
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

function isImportItemResult(value: unknown, index: number, dryRun: boolean): boolean {
	if (!isRecord(value) || value.index !== index) return false;
	const error = value.error;
	if (value.status === 'failed')
		return (
			value.link === undefined &&
			isRecord(error) &&
			isErrorCode(error.code) &&
			typeof error.message === 'string' &&
			(error.field === undefined || typeof error.field === 'string')
		);
	if (dryRun) return value.status === 'ready' && error === undefined && value.link === undefined;
	return value.status === 'created' && error === undefined && isLink(value.link);
}

export function isImportLinksResult(value: unknown): value is ImportLinksResult {
	if (!isRecord(value) || typeof value.dryRun !== 'boolean' || !Array.isArray(value.results))
		return false;
	const { dryRun } = value;
	const results: unknown[] = value.results;
	if (!results.every((item, index) => isImportItemResult(item, index, dryRun))) return false;
	const summary = value.summary;
	if (!isRecord(summary)) return false;
	const done = dryRun ? summary.ready : summary.created;
	const failed = results.filter((item) => isRecord(item) && item.status === 'failed').length;
	return done === results.length - failed && summary.failed === failed;
}
