// SPDX-License-Identifier: AGPL-3.0-only
// Browser export over the dashboard session: reads the /v1 export pages with the session cookie
// and builds the file that @flared/client/export writes. The page saves it.
import {
	linksCsv,
	writeExport,
	type ExportProgress,
	type ExportSource
} from '@flared/client/export';
import {
	isExportDimensionsPage,
	isExportLinkPage,
	isExportTotalsPage
} from '@flared/contracts/export';
import type { Link } from '@flared/contracts/links';

export class ExportFailure extends Error {
	constructor(readonly code: string) {
		super(code);
	}
}

const retries = 3;

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function errorCode(response: Response): Promise<string> {
	const body: unknown = await response.json().catch(() => null);
	return record(body) && record(body.error) && typeof body.error.code === 'string'
		? body.error.code
		: 'SERVICE_UNAVAILABLE';
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

// Reads one page. A busy or unavailable service is retried after its Retry-After, at most 30s.
async function readPage<T>(
	url: string,
	valid: (body: unknown) => body is T,
	signal: AbortSignal
): Promise<T> {
	for (let attempt = 0; ; attempt += 1) {
		let response: Response;
		try {
			response = await fetch(url, { signal, headers: { accept: 'application/json' } });
		} catch (error) {
			if (signal.aborted) throw error;
			if (attempt < retries) {
				await wait(2 ** attempt, signal);
				continue;
			}
			throw new ExportFailure('NETWORK_ERROR');
		}
		if (response.ok) {
			const body: unknown = await response.json().catch(() => null);
			if (!valid(body)) throw new ExportFailure('SERVICE_UNAVAILABLE');
			return body;
		}
		const code = await errorCode(response);
		const delay = Number(response.headers.get('retry-after') ?? 2 ** attempt);
		if ((response.status === 429 || response.status === 503) && attempt < retries)
			await wait(Math.min(Number.isFinite(delay) ? delay : 1, 30), signal);
		else throw new ExportFailure(code);
	}
}

export function sessionExportSource(apiBase: string, signal: AbortSignal): ExportSource {
	const url = (path: string, cursor?: string) =>
		`${apiBase}/export/${path}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`;
	return {
		exportLinks: (cursor) => readPage(url('links', cursor), isExportLinkPage, signal),
		exportDailyTotals: (cursor) =>
			readPage(url('daily-totals', cursor), isExportTotalsPage, signal),
		exportDailyDimensions: (cursor) =>
			readPage(url('daily-dimensions', cursor), isExportDimensionsPage, signal)
	};
}

export interface ExportFile {
	blob: Blob;
	filename: string;
	counts: ExportProgress;
}

const today = () => new Date().toISOString().slice(0, 10);

export async function buildExport(
	apiBase: string,
	signal: AbortSignal,
	onProgress: (progress: ExportProgress) => void
): Promise<ExportFile> {
	const parts: string[] = [];
	const counts = await writeExport(
		sessionExportSource(apiBase, signal),
		(text) => {
			parts.push(text);
		},
		{ onProgress, signal }
	);
	return {
		blob: new Blob(parts, { type: 'application/json' }),
		filename: `flared-export-${today()}.json`,
		counts
	};
}

export async function buildLinksCsv(
	apiBase: string,
	signal: AbortSignal,
	onProgress: (progress: ExportProgress) => void
): Promise<ExportFile> {
	const source = sessionExportSource(apiBase, signal);
	const links: Link[] = [];
	let cursor: string | undefined;
	do {
		const page = await source.exportLinks(cursor);
		links.push(...page.links);
		onProgress({ links: links.length, dailyTotals: 0, dailyDimensions: 0 });
		cursor = page.nextCursor ?? undefined;
	} while (cursor);
	return {
		blob: new Blob([linksCsv(links)], { type: 'text/csv' }),
		filename: `flared-links-${today()}.csv`,
		counts: { links: links.length, dailyTotals: 0, dailyDimensions: 0 }
	};
}

export function exportErrorMessage(code: string | null): string {
	switch (code) {
		case 'UNAUTHENTICATED':
			return 'Your session ended. Sign in again, then export.';
		case 'RATE_LIMITED':
			return 'Too many requests right now. Try the export again in a minute.';
		case 'NETWORK_ERROR':
			return 'We could not reach Flared. Check your connection and try again.';
		default:
			return 'The export did not finish. Try again.';
	}
}
