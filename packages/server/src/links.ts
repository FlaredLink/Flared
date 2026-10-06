// SPDX-License-Identifier: AGPL-3.0-only
// Link product rules on top of the routing store: slugs, create keys, and response bodies.
import type { D1Database } from '@cloudflare/workers-types/index.ts';
import type { ErrorBody, ErrorCode } from '@flared/contracts/errors';
import { errorStatus } from '@flared/contracts/errors';
import { exportLinkPageSize, type ExportLinkPage } from '@flared/contracts/export';
import type { CreateLinkInput, Link, LinkPage, UpdateLinkInput } from '@flared/contracts/links';
import { isReservedSlug } from '@flared/contracts/reserved';
import {
	createLinkRecord,
	findUsableDomain,
	listLinks as listLinkRows,
	readLink,
	readStoredResult,
	updateLink,
	type LinkRow
} from '@flared/data/links';

export const createKeyLifetimeMs = 24 * 60 * 60 * 1000;
const generatedSlugLength = 7;
const generatedSlugAttempts = 5;
const slugAlphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';

export interface ApiResult {
	status: number;
	body: string;
	replayed?: boolean;
}

export class ApiError extends Error {
	constructor(
		readonly code: ErrorCode,
		message: string,
		readonly retryAfterSeconds?: number
	) {
		super(message);
	}
}

export function errorBody(
	code: ErrorCode,
	message: string,
	requestId: string,
	field?: string
): string {
	const body: ErrorBody = { error: { code, message, requestId, ...(field ? { field } : {}) } };
	return JSON.stringify(body);
}

export function toApiLink(row: LinkRow): Link {
	return {
		id: row.id,
		domainId: row.domainId,
		hostname: row.hostname,
		slug: row.slug,
		shortUrl: `https://${row.hostname}/${row.slug}`,
		destination: row.destination,
		title: row.title,
		enabled: row.active,
		blocked: row.blockedReason ? { reason: row.blockedReason } : null,
		createdAt: new Date(row.createdAt).toISOString(),
		updatedAt: new Date(row.updatedAt).toISOString()
	};
}

// Rejection sampling keeps every character equally likely.
export function generateSlug(
	random: (bytes: Uint8Array) => void = (b) => crypto.getRandomValues(b)
): string {
	let slug = '';
	const limit = 256 - (256 % slugAlphabet.length);
	while (slug.length < generatedSlugLength) {
		const bytes = new Uint8Array(16);
		random(bytes);
		for (const byte of bytes)
			if (byte < limit && slug.length < generatedSlugLength)
				slug += slugAlphabet[byte % slugAlphabet.length];
	}
	return isReservedSlug(slug) ? generateSlug(random) : slug;
}

// Hash of the validated input. The omitted domain has its own marker, so a later change of
// the default domain cannot make a replay match a different request.
export async function hashCreateInput(input: CreateLinkInput): Promise<string> {
	const canonical = JSON.stringify([
		input.destination,
		input.slug,
		input.title,
		input.domainId === null ? { default: true } : { id: input.domainId }
	]);
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export interface CreateLinkRequest {
	tenantId: string;
	key: string;
	input: CreateLinkInput;
	requestId: string;
	now: number;
	newId?: () => string;
	newSlug?: () => string;
}

export async function createLink(
	routing: D1Database,
	request: CreateLinkRequest
): Promise<ApiResult> {
	const { tenantId, key, input, requestId, now } = request;
	const requestHash = await hashCreateInput(input);
	const domain = await findUsableDomain(routing, tenantId, input.domainId);
	if (!domain)
		throw input.domainId === null
			? new ApiError(
					'DEFAULT_DOMAIN_UNAVAILABLE',
					'The default short-link domain is not available.'
				)
			: new ApiError('DOMAIN_UNAVAILABLE', 'This domain is not active for your workspace.');
	const slugTaken = errorBody(
		'SLUG_TAKEN',
		'This slug is already taken on this domain.',
		requestId,
		'slug'
	);
	const limitReached = errorBody(
		'PLAN_LIMIT_REACHED',
		'Your workspace has reached its active link limit.',
		requestId
	);
	const attempts = input.slug === null ? generatedSlugAttempts : 1;
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		const slug = input.slug ?? (request.newSlug ?? generateSlug)();
		const linkId = (request.newId ?? (() => crypto.randomUUID()))();
		const link: Link = toApiLink({
			id: linkId,
			domainId: domain.id,
			hostname: domain.hostname,
			slug,
			destination: input.destination,
			title: input.title,
			active: true,
			blockedReason: null,
			createdAt: now,
			updatedAt: now
		});
		const outcome = await createLinkRecord(routing, {
			tenantId,
			key,
			requestHash,
			linkId,
			domainId: domain.id,
			slug,
			generatedSlug: input.slug === null,
			destination: input.destination,
			title: input.title,
			now,
			expiresAt: now + createKeyLifetimeMs,
			bodies: {
				created: JSON.stringify({ link }),
				slugTaken,
				limitReached
			}
		});
		if (outcome === 'created') return { status: 201, body: JSON.stringify({ link }) };
		if (outcome === 'slug_taken') return { status: 409, body: slugTaken };
		if (outcome === 'limit_reached') return { status: 403, body: limitReached };
		if (outcome === 'duplicate_key') return replay(routing, tenantId, key, requestHash, now);
		if (outcome === 'unavailable')
			throw new ApiError('SERVICE_UNAVAILABLE', 'Link creation is not available. Try again.');
	}
	throw new ApiError('SERVICE_UNAVAILABLE', 'Could not find a free slug. Try again.');
}

async function replay(
	routing: D1Database,
	tenantId: string,
	key: string,
	requestHash: string,
	now: number
): Promise<ApiResult> {
	const stored = await readStoredResult(routing, tenantId, key, now);
	if (!stored)
		throw new ApiError('SERVICE_UNAVAILABLE', 'Link creation is not available. Try again.');
	if (stored.requestHash !== requestHash)
		throw new ApiError(
			'IDEMPOTENCY_KEY_REUSED',
			'This Idempotency-Key was used for a different request. Use a new key.'
		);
	return { status: stored.status, body: stored.body, replayed: true };
}

export function encodeCursor(row: LinkRow): string {
	return `${row.createdAt}.${row.id}`;
}

export function decodeCursor(value: string): { createdAt: number; id: string } {
	const match = /^(\d{1,15})\.([A-Za-z0-9-]{1,64})$/.exec(value);
	if (!match)
		throw new ApiError('INVALID_INPUT', 'Use the nextCursor value from the previous page.');
	return { createdAt: Number(match[1]), id: match[2] };
}

export async function listLinks(
	routing: D1Database,
	tenantId: string,
	query: { limit: number; cursor: string | null; search: string | null },
	recentClicks: (linkIds: string[]) => Promise<Map<string, number> | null> = async () => null
): Promise<LinkPage> {
	const rows = await listLinkRows(routing, tenantId, {
		limit: query.limit + 1,
		after: query.cursor ? decodeCursor(query.cursor) : null,
		search: query.search
	});
	const page = rows.slice(0, query.limit);
	const last = page.at(-1);
	const clicks = await recentClicks(page.map((row) => row.id));
	return {
		links: page.map((row) => ({
			...toApiLink(row),
			clicksLast30Days: clicks ? (clicks.get(row.id) ?? 0) : null
		})),
		nextCursor: rows.length > query.limit && last ? encodeCursor(last) : null
	};
}

// Every link of the tenant, active and disabled, newest first, for an export.
export async function exportLinks(
	routing: D1Database,
	tenantId: string,
	cursor: string | null,
	limit = exportLinkPageSize
): Promise<ExportLinkPage> {
	const rows = await listLinkRows(routing, tenantId, {
		limit: limit + 1,
		after: cursor ? decodeCursor(cursor) : null,
		search: null
	});
	const page = rows.slice(0, limit);
	const last = page.at(-1);
	return {
		links: page.map(toApiLink),
		nextCursor: rows.length > limit && last ? encodeCursor(last) : null
	};
}

export async function getLink(
	routing: D1Database,
	tenantId: string,
	linkId: string
): Promise<Link> {
	const row = await readLink(routing, tenantId, linkId);
	if (!row) throw new ApiError('NOT_FOUND', 'Link not found.');
	return toApiLink(row);
}

export async function changeLink(
	routing: D1Database,
	tenantId: string,
	linkId: string,
	change: UpdateLinkInput,
	now: number
): Promise<Link> {
	const updated = await updateLink(routing, tenantId, linkId, {
		destination: change.destination,
		title: change.title,
		active: change.enabled,
		now
	});
	if (!updated) {
		const link = await readLink(routing, tenantId, linkId);
		if (!link) throw new ApiError('NOT_FOUND', 'Link not found.');
		if (link.blockedReason)
			throw new ApiError(
				'LINK_BLOCKED',
				'Flared blocked this link for abuse. You can only turn it off.'
			);
		throw new ApiError('PLAN_LIMIT_REACHED', 'Your workspace has reached its active link limit.');
	}
	return getLink(routing, tenantId, linkId);
}

export function statusOf(code: ErrorCode): number {
	return errorStatus[code];
}
