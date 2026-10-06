// SPDX-License-Identifier: AGPL-3.0-only
// Writes a workspace export from the /v1/export/* pages as one JSON document. The text goes out
// page by page, so the CLI can stream it to a file and the dashboard can collect it in a Blob
// without holding every row as an object.
import {
	exportFormat,
	type ExportDimensionsPage,
	type ExportLinkPage,
	type ExportTotalsPage
} from '@flared/contracts/export';
import type { Link } from '@flared/contracts/links';

// The API client provides these; the dashboard provides its own over the session.
export interface ExportSource {
	exportLinks(cursor?: string): Promise<ExportLinkPage>;
	exportDailyTotals(cursor?: string): Promise<ExportTotalsPage>;
	exportDailyDimensions(cursor?: string): Promise<ExportDimensionsPage>;
}

export interface ExportProgress {
	links: number;
	dailyTotals: number;
	dailyDimensions: number;
}

export interface ExportOptions {
	now?: () => number;
	onProgress?: (progress: ExportProgress) => void;
	// Checked before each page; the dashboard uses it to cancel.
	signal?: AbortSignal;
}

// Writes {"format", "exportedAt", "links", "dailyTotals", "dailyDimensions", "analyticsFrom",
// "retentionDays"} and returns the row counts.
export async function writeExport(
	source: ExportSource,
	write: (text: string) => void | Promise<void>,
	options: ExportOptions = {}
): Promise<ExportProgress> {
	const progress: ExportProgress = { links: 0, dailyTotals: 0, dailyDimensions: 0 };
	const exportedAt = new Date((options.now ?? Date.now)()).toISOString();
	await write(`{"format":${JSON.stringify(exportFormat)},"exportedAt":"${exportedAt}"`);

	async function section<T>(
		name: keyof ExportProgress,
		read: (cursor?: string) => Promise<{ rows: T[]; nextCursor: string | null }>
	): Promise<void> {
		await write(`,"${name}":[`);
		let cursor: string | undefined;
		do {
			options.signal?.throwIfAborted();
			const page = await read(cursor);
			if (page.rows.length > 0)
				await write(
					(progress[name] > 0 ? ',' : '') + page.rows.map((row) => JSON.stringify(row)).join(',')
				);
			progress[name] += page.rows.length;
			options.onProgress?.({ ...progress });
			cursor = page.nextCursor ?? undefined;
		} while (cursor);
		await write(']');
	}

	await section('links', async (cursor) => {
		const page = await source.exportLinks(cursor);
		return { rows: page.links, nextCursor: page.nextCursor };
	});
	let retained: { from: string; retentionDays: number } | null = null;
	await section('dailyTotals', async (cursor) => {
		const page = await source.exportDailyTotals(cursor);
		retained ??= { from: page.from, retentionDays: page.retentionDays };
		return page;
	});
	await section('dailyDimensions', (cursor) => source.exportDailyDimensions(cursor));
	const { from, retentionDays } = retained ?? { from: null, retentionDays: null };
	await write(
		`,"analyticsFrom":${JSON.stringify(from)},"retentionDays":${JSON.stringify(retentionDays)}}\n`
	);
	return progress;
}

const csvColumns = [
	'id',
	'shortUrl',
	'hostname',
	'slug',
	'destination',
	'title',
	'enabled',
	'createdAt',
	'updatedAt'
] as const;

// A spreadsheet opens a cell that starts with one of these as a formula.
const formulaStart = /^[=+\-@\t\r]/;

function csvCell(value: string): string {
	const safe = formulaStart.test(value) ? `'${value}` : value;
	return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

// The links as CSV with a header row and CRLF line ends.
export function linksCsv(links: Link[]): string {
	const rows = links.map((link) =>
		csvColumns.map((column) => csvCell(String(link[column] ?? ''))).join(',')
	);
	return [csvColumns.join(','), ...rows].join('\r\n') + '\r\n';
}
