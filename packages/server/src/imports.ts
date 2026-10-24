// SPDX-License-Identifier: AGPL-3.0-only
// Bulk link import: a dry run that reports what a real run would do, and a real run that creates
// each item with the single-link create, so quotas, slug reservations, and replays stay the same.
import type { D1Database } from '@cloudflare/workers-types/index.ts';
import { isErrorCode } from '@flared/contracts/errors';
import {
	LinkInputError,
	isLink,
	parseCreateLink,
	setsLinkAccess,
	setsLinkPreview,
	type CreateLinkInput,
	type ImportItemError,
	type ImportItemResult,
	type ImportLinksResult
} from '@flared/contracts/links';
import { findUsableDomain, readTakenSlugs, type DomainRow } from '@flared/data/links';
import { readLimitUsage, readLinkAccess, readLinkPreviews } from '@flared/data/routing-policy';
import type { LinkPasswords } from './link-passwords';
import {
	ApiError,
	createLink,
	domainUnavailable,
	limitReachedMessage,
	linkAccessMessage,
	linkPreviewMessage,
	slugTakenMessage
} from './links';

export type ImportItem =
	{ ok: true; input: CreateLinkInput } | { ok: false; error: ImportItemError };

// Each item gets the create validation; an invalid item fails alone.
export function parseImportItems(items: unknown[]): ImportItem[] {
	return items.map((item) => {
		try {
			return { ok: true, input: parseCreateLink(item) };
		} catch (error) {
			if (!(error instanceof LinkInputError)) throw error;
			return {
				ok: false,
				error: { code: 'INVALID_INPUT', message: error.message, field: error.field }
			};
		}
	});
}

// The condition leaves a non-array object, whose own keys are strings; reading a
// key from it gives unknown, so the cast adds no trust in the values.
function record(value: unknown): Record<string, unknown> | null {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function failed(index: number, error: ImportItemError): ImportItemResult {
	return { index, status: 'failed', error };
}

function apiFailure(error: ApiError): ImportItemError {
	return { code: error.code, message: error.message };
}

// Reads only. Checks the items in order with the create's rules: a usable domain, link access for
// dates and passwords, link previews for preview texts, room under the active link limit (earlier ready items included), then a
// free slug, also against earlier ready items in the request. A generated slug is never taken.
// passwords: the installation can store a link password.
export async function previewImport(
	routing: D1Database,
	tenantId: string,
	items: ImportItem[],
	features: { passwords: boolean }
): Promise<ImportLinksResult> {
	const usage = await readLimitUsage(routing, tenantId);
	if (!usage)
		throw new ApiError('SERVICE_UNAVAILABLE', 'Link creation is not available. Try again.');
	const linkAccess = items.some((item) => item.ok && setsLinkAccess(item.input))
		? await readLinkAccess(routing, tenantId)
		: false;
	const linkPreviews = items.some((item) => item.ok && setsLinkPreview(item.input))
		? await readLinkPreviews(routing, tenantId)
		: false;
	const domains = new Map<string | null, DomainRow | null>();
	for (const item of items)
		if (item.ok && !domains.has(item.input.domainId))
			domains.set(
				item.input.domainId,
				await findUsableDomain(routing, tenantId, item.input.domainId)
			);
	const addresses: { domainId: string; slug: string }[] = [];
	for (const item of items) {
		const domain = item.ok ? domains.get(item.input.domainId) : null;
		if (item.ok && domain && item.input.slug !== null)
			addresses.push({ domainId: domain.id, slug: item.input.slug });
	}
	const taken = new Set<string>();
	(await readTakenSlugs(routing, addresses)).forEach((isTaken, position) => {
		if (isTaken) taken.add(`${addresses[position].domainId}/${addresses[position].slug}`);
	});
	let ready = 0;
	const results = items.map((item, index): ImportItemResult => {
		if (!item.ok) return failed(index, item.error);
		const domain = domains.get(item.input.domainId);
		if (!domain) return failed(index, apiFailure(domainUnavailable(item.input.domainId)));
		if (setsLinkAccess(item.input) && !linkAccess)
			return failed(index, { code: 'LINK_ACCESS_REQUIRES_PLAN', message: linkAccessMessage });
		if (setsLinkPreview(item.input) && !linkPreviews)
			return failed(index, { code: 'LINK_PREVIEW_REQUIRES_PLAN', message: linkPreviewMessage });
		if (item.input.password !== null && !features.passwords)
			return failed(index, {
				code: 'SERVICE_UNAVAILABLE',
				message: 'Link passwords are not available on this installation.'
			});
		if (usage.links.used + ready >= usage.links.limit)
			return failed(index, { code: 'PLAN_LIMIT_REACHED', message: limitReachedMessage });
		if (item.input.slug !== null) {
			const address = `${domain.id}/${item.input.slug}`;
			if (taken.has(address))
				return failed(index, { code: 'SLUG_TAKEN', message: slugTakenMessage, field: 'slug' });
			taken.add(address);
		}
		ready += 1;
		return { index, status: 'ready' };
	});
	return { dryRun: true, results, summary: { ready, failed: results.length - ready } };
}

export interface ImportRun {
	tenantId: string;
	key: string;
	items: ImportItem[];
	requestId: string;
	now: number;
	passwords?: LinkPasswords;
}

// created counts links this call created; a replayed item reports its stored result again and
// counts as none. staged counts the created links that staged a webhook event. limitReached: an
// item this call tried was refused at the active link limit.
export interface ImportRunOutcome {
	result: ImportLinksResult;
	created: number;
	staged: number;
	limitReached: boolean;
}

// Creates the items in order. Each item has its own key, `${key}:${index}`, so a repeated
// request replays each stored result and creates nothing twice. The database enforces the limit.
export async function runImport(routing: D1Database, run: ImportRun): Promise<ImportRunOutcome> {
	let created = 0;
	let staged = 0;
	let limitReached = false;
	const results: ImportItemResult[] = [];
	for (const [index, item] of run.items.entries()) {
		if (!item.ok) {
			results.push(failed(index, item.error));
			continue;
		}
		let outcome;
		try {
			outcome = await createLink(routing, {
				tenantId: run.tenantId,
				key: `${run.key}:${index}`,
				input: item.input,
				requestId: run.requestId,
				now: run.now,
				passwords: run.passwords
			});
		} catch (error) {
			if (!(error instanceof ApiError)) throw error;
			results.push(failed(index, apiFailure(error)));
			continue;
		}
		const body = record(JSON.parse(outcome.body));
		const link = body?.link;
		const error = record(body?.error);
		if (outcome.status === 201 && isLink(link)) {
			results.push({ index, status: 'created', link });
			if (!outcome.replayed) created += 1;
			if (!outcome.replayed && outcome.eventStaged) staged += 1;
		} else if (error && isErrorCode(error.code) && typeof error.message === 'string') {
			const field = typeof error.field === 'string' ? { field: error.field } : {};
			results.push(failed(index, { code: error.code, message: error.message, ...field }));
			if (error.code === 'PLAN_LIMIT_REACHED' && !outcome.replayed) limitReached = true;
		} else throw new Error('Link creation returned an unexpected body');
	}
	const failures = results.filter((result) => result.status === 'failed').length;
	return {
		result: {
			dryRun: false,
			results,
			summary: { created: results.length - failures, failed: failures }
		},
		created,
		staged,
		limitReached
	};
}
