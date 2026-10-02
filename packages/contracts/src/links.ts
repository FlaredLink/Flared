// SPDX-License-Identifier: AGPL-3.0-only
import { isReservedSlug } from './reserved';

export const slugPattern = /^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])$/;
export const maxDestinationLength = 4096;
export const maxTitleLength = 200;
export const maxIdempotencyKeyLength = 255;

export interface Link {
	id: string;
	domainId: string;
	hostname: string;
	slug: string;
	shortUrl: string;
	destination: string;
	title: string | null;
	enabled: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface LinkPage {
	links: Link[];
	nextCursor: string | null;
}

export interface CreateLinkInput {
	destination: string;
	slug: string | null;
	title: string | null;
	domainId: string | null;
}

export interface UpdateLinkInput {
	destination?: string;
	title?: string | null;
	enabled?: boolean;
}

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

export function parseDestination(value: unknown): string {
	if (typeof value !== 'string' || !value.trim())
		throw new LinkInputError('destination', 'Enter a destination URL.');
	const input = value.trim();
	if (input.length > maxDestinationLength)
		throw new LinkInputError('destination', 'Use a destination of at most 4,096 characters.');
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		throw new LinkInputError('destination', 'Enter a full URL that starts with https://.');
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:')
		throw new LinkInputError('destination', 'Use an http or https URL.');
	if (url.username || url.password)
		throw new LinkInputError('destination', 'Remove the user name or password from the URL.');
	if (!url.hostname) throw new LinkInputError('destination', 'Enter a URL with a host name.');
	if (url.href.length > maxDestinationLength)
		throw new LinkInputError('destination', 'Use a destination of at most 4,096 characters.');
	return url.href;
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
	onlyFields(body, ['destination', 'slug', 'title', 'domainId']);
	const domainId = body.domainId;
	if (domainId !== undefined && domainId !== null && (typeof domainId !== 'string' || !domainId))
		throw new LinkInputError('domainId', 'Use a domain ID from GET /v1/domains.');
	return {
		destination: parseDestination(body.destination),
		slug: parseSlug(body.slug),
		title: parseTitle(body.title),
		domainId: typeof domainId === 'string' ? domainId : null
	};
}

export function parseUpdateLink(value: unknown): UpdateLinkInput {
	const body = record(value);
	onlyFields(body, ['destination', 'title', 'enabled']);
	const update: UpdateLinkInput = {};
	if (body.destination !== undefined) update.destination = parseDestination(body.destination);
	if (body.title !== undefined) update.title = parseTitle(body.title);
	if (body.enabled !== undefined) {
		if (typeof body.enabled !== 'boolean')
			throw new LinkInputError('enabled', 'Use true or false.');
		update.enabled = body.enabled;
	}
	if (Object.keys(update).length === 0)
		throw new LinkInputError('body', 'Change the destination, title, or enabled state.');
	return update;
}

// Printable ASCII only, so the key is safe to store and compare.
export function parseIdempotencyKey(value: string | null): string | null {
	if (value === null) return null;
	if (!value || value.length > maxIdempotencyKeyLength || !/^[\x21-\x7e]+$/.test(value))
		return null;
	return value;
}
