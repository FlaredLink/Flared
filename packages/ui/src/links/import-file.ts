// SPDX-License-Identifier: AGPL-3.0-only
// Reads a links file for import: a CSV from another link service or a Flared export, and plans
// each row against the workspace's domains. Pure functions over text, so they run anywhere.
import type { Domain } from '@flared/contracts/domains';
import { exportFormat } from '@flared/contracts/export';
import {
	LinkInputError,
	maxTitleLength,
	parseDestination,
	parseDeviceDestination,
	parseSlug
} from '@flared/contracts/links';

export const maxCsvBytes = 5 * 1024 * 1024;
// A Flared export also holds daily click rows, so it is allowed to be larger than a CSV.
export const maxJsonBytes = 25 * 1024 * 1024;
export const maxImportRows = 10_000;

export class ImportFileError extends Error {}

export type ImportFileKind = 'csv' | 'json';

export function fileKind(name: string, text: string): ImportFileKind {
	const lower = name.toLowerCase();
	if (lower.endsWith('.json')) return 'json';
	if (lower.endsWith('.csv')) return 'csv';
	return text.replace(/^﻿/, '').trimStart().startsWith('{') ? 'json' : 'csv';
}

// A message when the file is too large to read, or null.
export function fileSizeProblem(kind: ImportFileKind, bytes: number): string | null {
	const limit = kind === 'json' ? maxJsonBytes : maxCsvBytes;
	return bytes > limit
		? `This file is larger than ${limit / 1024 / 1024} MB. Split it into smaller files.`
		: null;
}

function tooManyRows(): ImportFileError {
	return new ImportFileError(
		`This file has more than ${maxImportRows.toLocaleString('en-US')} links. Split it into smaller files.`
	);
}

// RFC 4180: comma separated, CRLF or LF line ends, double quotes around a value that holds a
// comma, a quote, or a line end, and "" for a quote inside it. A UTF-8 byte order mark and a
// final line end are ignored.
export function parseCsv(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let cell = '';
	let quoted = false;
	let atStart = true;
	for (let index = text.charCodeAt(0) === 0xfeff ? 1 : 0; index < text.length; index += 1) {
		const char = text[index];
		if (quoted) {
			if (char !== '"') cell += char;
			else if (text[index + 1] === '"') {
				cell += '"';
				index += 1;
			} else quoted = false;
			continue;
		}
		if (char === '"' && atStart) {
			quoted = true;
			atStart = false;
		} else if (char === ',') {
			row.push(cell);
			cell = '';
			atStart = true;
		} else if (char === '\r' || char === '\n') {
			if (char === '\r' && text[index + 1] === '\n') index += 1;
			row.push(cell);
			rows.push(row);
			row = [];
			cell = '';
			atStart = true;
		} else {
			cell += char;
			atStart = false;
		}
	}
	if (quoted) throw new ImportFileError('A quoted value in this file has no closing quote.');
	if (cell !== '' || row.length > 0) {
		row.push(cell);
		rows.push(row);
	}
	return rows;
}

// One link from the file. row counts the header as row 1, so it matches a spreadsheet.
export interface ImportRow {
	row: number;
	// The old short link, such as https://bit.ly/abc, or '' when the file has none.
	shortUrl: string;
	destination: string;
	title: string;
	iosDestination: string;
	androidDestination: string;
}

export interface CsvFile {
	kind: 'csv';
	headers: string[];
	// Data rows without the header; rows with no value at all are left out.
	rows: { row: number; cells: string[] }[];
}

export interface FlaredFile {
	kind: 'flared';
	rows: ImportRow[];
}

export type ImportFile = CsvFile | FlaredFile;

export function readCsvFile(text: string): CsvFile {
	const [headers, ...data] = parseCsv(text);
	if (!headers || headers.every((cell) => !cell.trim()))
		throw new ImportFileError('This file is empty. Export your links again.');
	const rows = data
		.map((cells, index) => ({ row: index + 2, cells }))
		.filter(({ cells }) => cells.some((cell) => cell.trim()));
	if (rows.length === 0) throw new ImportFileError('This file has no links.');
	if (rows.length > maxImportRows) throw tooManyRows();
	return { kind: 'csv', headers: headers.map((cell) => cell.trim()), rows };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

// A Flared export file (flared.export/1). Only the links are read; click history stays behind.
export function readFlaredExport(source: string): FlaredFile {
	let value: unknown;
	try {
		value = JSON.parse(source);
	} catch {
		throw new ImportFileError('This file is not valid JSON. Use a Flared export file.');
	}
	if (!isRecord(value) || value.format !== exportFormat || !Array.isArray(value.links))
		throw new ImportFileError('This JSON file is not a Flared export. Use a Flared export file.');
	const links: unknown[] = value.links;
	if (links.length === 0) throw new ImportFileError('This file has no links.');
	if (links.length > maxImportRows) throw tooManyRows();
	const rows = links.map((link, index): ImportRow => {
		const item = isRecord(link) ? link : {};
		const hostname = text(item.hostname);
		const slug = text(item.slug);
		return {
			row: index + 1,
			shortUrl: text(item.shortUrl) || (hostname && slug ? `https://${hostname}/${slug}` : ''),
			destination: text(item.destination),
			title: text(item.title),
			iosDestination: text(item.iosDestination),
			androidDestination: text(item.androidDestination)
		};
	});
	return { kind: 'flared', rows };
}

export function readImportFile(name: string, source: string): ImportFile {
	return fileKind(name, source) === 'json' ? readFlaredExport(source) : readCsvFile(source);
}

// Where the old short link comes from: one column with the full link, a hostname column and a
// slug column (as in a Flared CSV), or nowhere, in which case each link gets a new ending.
export type ShortColumns =
	| { kind: 'url'; column: number }
	| { kind: 'parts'; hostname: number; slug: number }
	| { kind: 'none' };

export interface CsvColumns {
	short: ShortColumns;
	destination: number | null;
	title: number | null;
}

function normal(header: string): string {
	return header.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// In order of preference: a specific name wins over a general one such as "link" or "url".
const shortAliases = ['shortlink', 'shorturl', 'bitlink', 'shortlinkurl', 'link'];
const destinationAliases = [
	'longurl',
	'destination',
	'destinationurl',
	'originalurl',
	'targeturl',
	'url'
];
const titleAliases = ['title', 'name'];
const hostnameAliases = ['hostname', 'domain'];
const slugAliases = ['slug', 'key', 'backhalf'];

function findColumn(headers: string[], aliases: string[], skip: number[] = []): number | null {
	const names = headers.map(normal);
	for (const alias of aliases) {
		const index = names.findIndex((name, column) => name === alias && !skip.includes(column));
		if (index !== -1) return index;
	}
	return null;
}

export function guessColumns(headers: string[]): CsvColumns {
	const url = findColumn(headers, shortAliases);
	const destination = findColumn(headers, destinationAliases, url === null ? [] : [url]);
	const taken = [url, destination].filter((column) => column !== null);
	const title = findColumn(headers, titleAliases, taken);
	let short: ShortColumns = { kind: 'none' };
	if (url !== null) short = { kind: 'url', column: url };
	else {
		const hostname = findColumn(headers, hostnameAliases, taken);
		const slug = findColumn(headers, slugAliases, taken);
		if (hostname !== null && slug !== null) short = { kind: 'parts', hostname, slug };
	}
	return { short, destination, title };
}

export function rowsFromCsv(file: CsvFile, columns: CsvColumns): ImportRow[] {
	const cell = (cells: string[], column: number | null) =>
		column === null ? '' : (cells[column] ?? '').trim();
	return file.rows.map(({ row, cells }) => {
		const { short } = columns;
		let shortUrl = '';
		if (short.kind === 'url') shortUrl = cell(cells, short.column);
		else if (short.kind === 'parts') {
			const hostname = cell(cells, short.hostname);
			const slug = cell(cells, short.slug);
			shortUrl = hostname && slug ? `${hostname}/${slug}` : '';
		}
		return {
			row,
			shortUrl,
			destination: cell(cells, columns.destination),
			title: cell(cells, columns.title),
			iosDestination: '',
			androidDestination: ''
		};
	});
}

// Splits a short link into its hostname and slug. Accepts a link without a scheme, a trailing
// slash, a query, or a fragment. Returns null when the text is not an address.
export function splitShortUrl(value: string): { hostname: string; slug: string } | null {
	const input = value.trim();
	if (!input || /\s/.test(input)) return null;
	let url: URL;
	try {
		url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`);
	} catch {
		return null;
	}
	if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !url.hostname.includes('.'))
		return null;
	let path: string;
	try {
		path = decodeURIComponent(url.pathname);
	} catch {
		path = url.pathname;
	}
	return {
		hostname: url.hostname.toLowerCase().replace(/\.$/, ''),
		slug: path.replace(/^\/+|\/+$/g, '')
	};
}

// The fields of one item in POST /v1/links/import.
export interface ImportItemInput {
	destination: string;
	slug?: string;
	title?: string;
	domainId?: string;
	iosDestination?: string;
	androidDestination?: string;
}

export type ImportDomain = Pick<Domain, 'id' | 'hostname' | 'state' | 'isDefault'>;

// own: the link is on a domain the workspace has connected, or the file names no short link.
// other: the link is on a hostname the workspace has not connected; it can be copied to the
// default domain, with a new ending when its own cannot be used there (newEnding).
// invalid: the row cannot be imported; reason says why.
export type PlannedRow =
	| { kind: 'own'; row: ImportRow; item: ImportItemInput }
	| { kind: 'other'; row: ImportRow; hostname: string; item: ImportItemInput; newEnding: boolean }
	| { kind: 'invalid'; row: ImportRow; reason: string };

export interface ImportPlan {
	rows: PlannedRow[];
	// Hostnames of other services, the most common first.
	otherHosts: string[];
}

function problem(read: () => unknown): string | null {
	try {
		read();
		return null;
	} catch (error) {
		if (error instanceof LinkInputError) return error.message;
		throw error;
	}
}

function cleanTitle(value: string): string {
	return value
		.replace(/\p{Cc}/gu, ' ')
		.trim()
		.slice(0, maxTitleLength)
		.trim();
}

function withOptional(item: ImportItemInput, row: ImportRow): ImportItemInput {
	const title = cleanTitle(row.title);
	if (title) item.title = title;
	if (row.iosDestination.trim()) item.iosDestination = row.iosDestination.trim();
	if (row.androidDestination.trim()) item.androidDestination = row.androidDestination.trim();
	return item;
}

const defaultKey = 'default';

export function planImport(
	rows: ImportRow[],
	domains: ImportDomain[],
	defaultHost: string | null
): ImportPlan {
	const byHost = new Map(domains.map((domain) => [domain.hostname.toLowerCase(), domain]));
	const defaultHostname =
		domains.find((domain) => domain.isDefault)?.hostname.toLowerCase() ??
		defaultHost?.toLowerCase() ??
		null;
	// Addresses the file already uses, so a repeated slug fails before the API sees it. Links
	// on the workspace's own domains come first; a copied link yields to them.
	const used = new Set<string>();
	const planned: (PlannedRow | null)[] = rows.map((row) => {
		const destinationProblem =
			problem(() => parseDestination(row.destination)) ??
			problem(() => parseDeviceDestination(row.iosDestination, 'iosDestination')) ??
			problem(() => parseDeviceDestination(row.androidDestination, 'androidDestination'));
		if (destinationProblem) return { kind: 'invalid', row, reason: destinationProblem };
		const item = withOptional({ destination: row.destination.trim() }, row);
		if (!row.shortUrl) return { kind: 'own', row, item };
		const short = splitShortUrl(row.shortUrl);
		if (!short) return { kind: 'invalid', row, reason: 'The short link is not a valid address.' };
		const domain = byHost.get(short.hostname);
		const own = domain !== undefined || short.hostname === defaultHostname;
		if (!own) return null;
		if (domain && domain.state !== 'active')
			return {
				kind: 'invalid',
				row,
				reason: `${domain.hostname} is not active yet. Finish its setup in Domains.`
			};
		if (!short.slug)
			return { kind: 'invalid', row, reason: 'The short link has no ending after the domain.' };
		const slugProblem = problem(() => parseSlug(short.slug));
		if (slugProblem) return { kind: 'invalid', row, reason: slugProblem };
		const domainKey = !domain || domain.isDefault ? defaultKey : domain.id;
		const address = `${domainKey}/${short.slug}`;
		if (used.has(address))
			return { kind: 'invalid', row, reason: 'This short link is in the file more than once.' };
		used.add(address);
		if (domain && !domain.isDefault) item.domainId = domain.id;
		item.slug = short.slug;
		return { kind: 'own', row, item };
	});
	const hostCounts = new Map<string, number>();
	const result = planned.map((plan, index): PlannedRow => {
		if (plan) return plan;
		const row = rows[index];
		const item = withOptional({ destination: row.destination.trim() }, row);
		// Only rows on another service's hostname are left; splitShortUrl succeeded for them.
		const short = splitShortUrl(row.shortUrl) ?? { hostname: '', slug: '' };
		hostCounts.set(short.hostname, (hostCounts.get(short.hostname) ?? 0) + 1);
		const address = `${defaultKey}/${short.slug}`;
		const usable = short.slug !== '' && problem(() => parseSlug(short.slug)) === null;
		if (usable && !used.has(address)) {
			used.add(address);
			item.slug = short.slug;
		}
		return {
			kind: 'other',
			row,
			hostname: short.hostname,
			item,
			newEnding: item.slug === undefined
		};
	});
	const otherHosts = [...hostCounts.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([hostname]) => hostname);
	return { rows: result, otherHosts };
}

// A spreadsheet opens a cell that starts with one of these as a formula.
const formulaStart = /^[=+\-@\t\r]/;

function csvCell(value: string): string {
	const safe = formulaStart.test(value) ? `'${value}` : value;
	return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

// The rows that were not imported, with the reason, as a CSV this dialog can read again.
export function failedRowsCsv(rows: { row: ImportRow; reason: string }[]): string {
	const lines = rows.map(({ row, reason }) =>
		[row.shortUrl, row.destination, row.title, reason].map(csvCell).join(',')
	);
	return ['short_url,destination,title,reason', ...lines].join('\r\n') + '\r\n';
}
