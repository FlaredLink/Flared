// SPDX-License-Identifier: AGPL-3.0-only
// Browser calls to POST /v1/links/import over the dashboard session. The page passes its API
// base path; each request sends at most batchSize items, the most the server takes at once.
import {
	isImportLinksResult,
	type ImportItemError,
	type ImportLinksResult
} from '@flared/contracts/links';
import type { ImportItemInput } from './import-file';

export interface ImportFailure {
	code: string;
	message: string | null;
	retryAfterSeconds: number | null;
}

type Sent = { ok: true; result: ImportLinksResult } | ({ ok: false } & ImportFailure);

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function failureOf(response: Response): Promise<ImportFailure> {
	const body: unknown = await response.json().catch(() => null);
	const error = record(body) && record(body.error) ? body.error : {};
	const retryAfter = Number(response.headers.get('retry-after'));
	// Any 429 is a wait, also one from a proxy without a Flared error body.
	const code =
		response.status === 429
			? 'RATE_LIMITED'
			: typeof error.code === 'string'
				? error.code
				: 'SERVICE_UNAVAILABLE';
	return {
		code,
		message: typeof error.message === 'string' ? error.message : null,
		retryAfterSeconds: Number.isSafeInteger(retryAfter) && retryAfter > 0 ? retryAfter : null
	};
}

// One request. A network error is retried once with the same key, so a real run that reached
// the server replays its stored results and creates nothing twice.
async function send(
	apiBase: string,
	items: ImportItemInput[],
	dryRun: boolean,
	key: string,
	headers: Record<string, string>,
	signal: AbortSignal
): Promise<Sent> {
	for (let attempt = 0; ; attempt += 1) {
		let response: Response;
		try {
			response = await fetch(`${apiBase}/links/import`, {
				method: 'POST',
				signal,
				headers: {
					accept: 'application/json',
					'content-type': 'application/json',
					'idempotency-key': key,
					...headers
				},
				body: JSON.stringify({ dryRun, items })
			});
		} catch (error) {
			if (signal.aborted) throw error;
			if (attempt === 0) continue;
			return { ok: false, code: 'NETWORK_ERROR', message: null, retryAfterSeconds: null };
		}
		if (!response.ok) return { ok: false, ...(await failureOf(response)) };
		const body: unknown = await response.json().catch(() => null);
		if (
			!isImportLinksResult(body) ||
			body.dryRun !== dryRun ||
			body.results.length !== items.length
		)
			return { ok: false, code: 'SERVICE_UNAVAILABLE', message: null, retryAfterSeconds: null };
		return { ok: true, result: body };
	}
}

function wait(seconds: number, signal: AbortSignal): Promise<void> {
	return new Promise((done, fail) => {
		const timer = setTimeout(done, seconds * 1000);
		signal.addEventListener(
			'abort',
			() => {
				clearTimeout(timer);
				fail(signal.reason);
			},
			{ once: true }
		);
	});
}

// A wait longer than this stops the run; the rest can be imported later.
export const maxPauseSeconds = 120;
const maxPausesPerChunk = 5;

export interface ChunkRun {
	apiBase: string;
	headers: Record<string, string>;
	batchSize: number;
	dryRun: boolean;
	signal: AbortSignal;
	// start is the position of the chunk's first item.
	onChunk: (start: number, result: ImportLinksResult) => void;
	// The server asked to wait; the run continues after seconds.
	onPause: (seconds: number) => void;
}

// ok: false stops at the item at position at; nothing from there on was sent.
export type ChunkRunEnd = { ok: true } | ({ ok: false; at: number } & ImportFailure);

// Sends the items in order in chunks of batchSize. Each chunk has its own Idempotency-Key.
// Throws when signal aborts.
export async function runImportChunks(
	items: ImportItemInput[],
	run: ChunkRun
): Promise<ChunkRunEnd> {
	const size = Math.max(1, Math.floor(run.batchSize));
	for (let start = 0; start < items.length; start += size) {
		const chunk = items.slice(start, start + size);
		const key = crypto.randomUUID();
		for (let pauses = 0; ; pauses += 1) {
			run.signal.throwIfAborted();
			const sent = await send(run.apiBase, chunk, run.dryRun, key, run.headers, run.signal);
			if (sent.ok) {
				run.onChunk(start, sent.result);
				break;
			}
			const seconds = sent.retryAfterSeconds ?? 60;
			if (
				sent.code === 'RATE_LIMITED' &&
				seconds <= maxPauseSeconds &&
				pauses < maxPausesPerChunk
			) {
				run.onPause(seconds);
				await wait(seconds, run.signal);
				continue;
			}
			return {
				ok: false,
				at: start,
				code: sent.code,
				message: sent.message,
				retryAfterSeconds: sent.retryAfterSeconds
			};
		}
	}
	return { ok: true };
}

// Why one item was not imported, in plain words.
export function importItemReason(error: ImportItemError): string {
	switch (error.code) {
		// The API names the exact problem with the field.
		case 'INVALID_INPUT':
			return error.message;
		case 'SLUG_TAKEN':
			return 'This ending is already taken on that domain.';
		case 'PLAN_LIMIT_REACHED':
			return 'You have reached your active link limit.';
		case 'DOMAIN_UNAVAILABLE':
			return 'The domain is not active. Check it in Domains.';
		case 'DEFAULT_DOMAIN_UNAVAILABLE':
			return 'Short links are not available right now. Try this row again later.';
		case 'LINK_BLOCKED':
			return 'Flared does not accept this destination.';
		default:
			return error.message || 'This link could not be imported.';
	}
}

// Why the whole import stopped, in plain words.
export function importStopReason(failure: ImportFailure): string {
	switch (failure.code) {
		case 'RATE_LIMITED': {
			const minutes = Math.ceil((failure.retryAfterSeconds ?? 3600) / 60);
			return `Too many links imported for now. Import the rest in ${minutes === 1 ? '1 minute' : `${minutes} minutes`}.`;
		}
		case 'UNAUTHENTICATED':
			return 'Your session ended. Sign in again, then import the rest.';
		case 'WORKSPACE_CHANGED':
			return 'You switched workspaces in another tab. Reload the page to continue.';
		case 'WORKSPACE_SUSPENDED':
			return 'Flared suspended this workspace. You can still export your data.';
		case 'WORKSPACE_PENDING':
			return 'Your workspace is still being set up. Try again in a minute.';
		case 'INSUFFICIENT_SCOPE':
		case 'OWNER_REQUIRED':
			return 'Your role in this workspace does not allow imports.';
		case 'TOO_MANY_ITEMS':
			return 'The server takes fewer links in one request than this page sent.';
		case 'NETWORK_ERROR':
			return 'We could not reach Flared. Check your connection and try again.';
		default:
			return 'The import stopped. Try again.';
	}
}
