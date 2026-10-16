// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { linksCsv } from '../packages/client/src/export';
import type { Link } from '../packages/contracts/src/links';
import {
	ImportFileError,
	failedRowsCsv,
	fileKind,
	fileSizeProblem,
	guessColumns,
	maxCsvBytes,
	maxImportRows,
	maxJsonBytes,
	parseCsv,
	planImport,
	readCsvFile,
	readFlaredExport,
	readImportFile,
	rowsFromCsv,
	splitShortUrl,
	type ImportDomain,
	type ImportRow
} from '../packages/ui/src/links/import-file';

const domains: ImportDomain[] = [
	{ id: 'dom_default', hostname: 'flared.link', state: 'active', isDefault: true },
	{ id: 'dom_own', hostname: 'go.example.com', state: 'active', isDefault: false },
	{ id: 'dom_pending', hostname: 'new.example.com', state: 'pending', isDefault: false }
];

function row(shortUrl: string, destination = 'https://example.com/page', row = 2): ImportRow {
	return { row, shortUrl, destination, title: '', iosDestination: '', androidDestination: '' };
}

describe('parseCsv', () => {
	it('reads quoted values with commas, escaped quotes, and line ends', () => {
		const text = 'a,b,c\r\n"x, y","say ""hi""","line 1\nline 2"\r\n';
		expect(parseCsv(text)).toEqual([
			['a', 'b', 'c'],
			['x, y', 'say "hi"', 'line 1\nline 2']
		]);
	});

	it('ignores a byte order mark and accepts LF and CRLF in one file', () => {
		expect(parseCsv('﻿a,b\nc,d\r\ne,f')).toEqual([
			['a', 'b'],
			['c', 'd'],
			['e', 'f']
		]);
	});

	it('keeps empty cells and drops only the trailing line end', () => {
		expect(parseCsv('a,,c\r\n,,\r\n')).toEqual([
			['a', '', 'c'],
			['', '', '']
		]);
		expect(parseCsv('"",x')).toEqual([['', 'x']]);
	});

	it('refuses a quote that never closes', () => {
		expect(() => parseCsv('a\n"open,value')).toThrow(ImportFileError);
	});
});

describe('readCsvFile', () => {
	it('skips blank rows and numbers rows as a spreadsheet does', () => {
		const file = readCsvFile('Short URL,Long URL\n\nbit.ly/abc,https://a.example\n,\n');
		expect(file.headers).toEqual(['Short URL', 'Long URL']);
		expect(file.rows).toEqual([{ row: 3, cells: ['bit.ly/abc', 'https://a.example'] }]);
	});

	it('refuses an empty file and a file without links', () => {
		expect(() => readCsvFile('')).toThrow('empty');
		expect(() => readCsvFile('short,long\r\n')).toThrow('no links');
	});

	it('refuses more rows than the limit', () => {
		const lines = ['short,long'];
		for (let index = 0; index <= maxImportRows; index += 1)
			lines.push(`,https://e.example/${index}`);
		expect(() => readCsvFile(lines.join('\n'))).toThrow('more than 10,000 links');
	});
});

describe('guessColumns', () => {
	it.each([
		[['Title', 'Bitlink', 'Long URL'], 1, 2, 0],
		[['Short link', 'Destination URL', 'Name'], 0, 1, 2],
		[['shortUrl', 'destination', 'title'], 0, 1, 2],
		[['short_url', 'original_url'], 0, 1, null],
		[['link', 'url'], 0, 1, null],
		[['Short URL', 'Original URL', 'Title'], 0, 1, 2]
	])('finds the columns in %j', (headers, short, destination, title) => {
		expect(guessColumns(headers)).toEqual({
			short: { kind: 'url', column: short },
			destination,
			title
		});
	});

	it('uses hostname and slug columns when there is no short link column', () => {
		expect(guessColumns(['domain', 'key', 'url'])).toEqual({
			short: { kind: 'parts', hostname: 0, slug: 1 },
			destination: 2,
			title: null
		});
	});

	it('reads the columns of a Flared CSV export', () => {
		const link: Link = {
			id: 'lnk_1',
			domainId: 'dom_own',
			hostname: 'go.example.com',
			slug: 'launch',
			shortUrl: 'https://go.example.com/launch',
			destination: 'https://example.com/launch',
			title: 'Launch, day one',
			enabled: true,
			blocked: null,
			createdAt: '2026-10-01T00:00:00.000Z',
			updatedAt: '2026-10-01T00:00:00.000Z'
		};
		const file = readCsvFile(linksCsv([link]));
		const columns = guessColumns(file.headers);
		expect(columns.short).toEqual({ kind: 'url', column: 1 });
		expect(rowsFromCsv(file, columns)).toEqual([
			{
				row: 2,
				shortUrl: 'https://go.example.com/launch',
				destination: 'https://example.com/launch',
				title: 'Launch, day one',
				iosDestination: '',
				androidDestination: ''
			}
		]);
	});

	it('joins hostname and slug columns into a short link', () => {
		const file = readCsvFile('hostname,slug,destination\ngo.example.com,abc,https://e.example\n');
		const rows = rowsFromCsv(file, guessColumns(file.headers));
		expect(rows[0].shortUrl).toBe('go.example.com/abc');
	});
});

describe('splitShortUrl', () => {
	it.each([
		['https://bit.ly/abc', 'bit.ly', 'abc'],
		['bit.ly/abc', 'bit.ly', 'abc'],
		['http://Bit.LY/abc/', 'bit.ly', 'abc'],
		['https://dub.sh/abc?ref=x#top', 'dub.sh', 'abc'],
		['go.example.com', 'go.example.com', '']
	])('splits %s', (value, hostname, slug) => {
		expect(splitShortUrl(value)).toEqual({ hostname, slug });
	});

	it.each(['', 'not a link', 'ftp://bit.ly/abc', 'localhost/abc'])('refuses %j', (value) => {
		expect(splitShortUrl(value)).toBeNull();
	});
});

describe('planImport', () => {
	it('keeps the slug and domain of links on connected domains', () => {
		const plan = planImport(
			[row('https://go.example.com/launch'), row('flared.link/spring')],
			domains,
			null
		);
		expect(plan.rows.map((planned) => planned.kind === 'own' && planned.item)).toEqual([
			{ destination: 'https://example.com/page', slug: 'launch', domainId: 'dom_own' },
			{ destination: 'https://example.com/page', slug: 'spring' }
		]);
	});

	it('uses the fallback default hostname when no domain is the default', () => {
		const plan = planImport([row('links.example.org/abc')], [], 'links.example.org');
		expect(plan.rows[0]).toMatchObject({ kind: 'own', item: { slug: 'abc' } });
	});

	it('groups unconnected hostnames, the most common first', () => {
		const plan = planImport(
			[row('dub.sh/one'), row('bit.ly/two'), row('bit.ly/three'), row('rebrand.ly/x1')],
			domains,
			null
		);
		expect(plan.rows.every((planned) => planned.kind === 'other')).toBe(true);
		expect(plan.otherHosts).toEqual(['bit.ly', 'dub.sh', 'rebrand.ly']);
	});

	it('gives a copied link a new ending when its own cannot be used', () => {
		const plan = planImport(
			[row('flared.link/abc'), row('bit.ly/abc'), row('bit.ly/3xYz'), row('bit.ly/a')],
			domains,
			null
		);
		expect(plan.rows.slice(1)).toMatchObject([
			{ kind: 'other', newEnding: true },
			{ kind: 'other', newEnding: true },
			{ kind: 'other', newEnding: true }
		]);
		expect(plan.rows[0]).toMatchObject({ kind: 'own', item: { slug: 'abc' } });
		for (const planned of plan.rows.slice(1))
			expect(planned.kind === 'other' && planned.item).not.toHaveProperty('slug');
	});

	it('copies a usable ending to the default domain', () => {
		const plan = planImport([row('bit.ly/spring-sale')], domains, null);
		expect(plan.rows[0]).toMatchObject({
			kind: 'other',
			hostname: 'bit.ly',
			newEnding: false,
			item: { slug: 'spring-sale' }
		});
	});

	it('marks rows that cannot be imported, with a reason', () => {
		const plan = planImport(
			[
				row('go.example.com/abc', 'not a url'),
				row('go.example.com/abc'),
				row('go.example.com/abc'),
				row('new.example.com/abc'),
				row('go.example.com/'),
				row('go.example.com/Mixed'),
				row('::::')
			],
			domains,
			null
		);
		const reasons = plan.rows.map((planned) =>
			planned.kind === 'invalid' ? planned.reason : planned.kind
		);
		expect(reasons).toEqual([
			'Enter a full URL that starts with https://.',
			'own',
			'This short link is in the file more than once.',
			'new.example.com is not active yet. Finish its setup in Domains.',
			'The short link has no ending after the domain.',
			expect.stringContaining('lowercase'),
			'The short link is not a valid address.'
		]);
	});

	it('creates links without a short link on the default domain with a new ending', () => {
		const plan = planImport([{ ...row(''), title: '  Spring\tsale  ' }], domains, null);
		expect(plan.rows[0]).toEqual({
			kind: 'own',
			row: expect.anything(),
			item: { destination: 'https://example.com/page', title: 'Spring sale' }
		});
	});
});

describe('readFlaredExport', () => {
	it('reads the links of a flared.export/1 file', () => {
		const file = readFlaredExport(
			JSON.stringify({
				format: 'flared.export/1',
				exportedAt: '2026-10-01T00:00:00.000Z',
				links: [
					{
						shortUrl: 'https://go.example.com/a1b',
						destination: 'https://example.com',
						title: null,
						iosDestination: 'myapp://open'
					},
					{ hostname: 'flared.link', slug: 'x2y', destination: 'https://example.org' }
				],
				dailyTotals: [],
				dailyDimensions: []
			})
		);
		expect(file.rows).toEqual([
			{
				row: 1,
				shortUrl: 'https://go.example.com/a1b',
				destination: 'https://example.com',
				title: '',
				iosDestination: 'myapp://open',
				androidDestination: ''
			},
			{
				row: 2,
				shortUrl: 'https://flared.link/x2y',
				destination: 'https://example.org',
				title: '',
				iosDestination: '',
				androidDestination: ''
			}
		]);
		const plan = planImport(file.rows, domains, null);
		expect(plan.rows[0]).toMatchObject({
			kind: 'own',
			item: { slug: 'a1b', domainId: 'dom_own', iosDestination: 'myapp://open' }
		});
	});

	it.each([
		['{', 'not valid JSON'],
		['[]', 'not a Flared export'],
		['{"format":"flared.export/2","links":[]}', 'not a Flared export'],
		['{"format":"flared.export/1","links":{}}', 'not a Flared export'],
		['{"format":"flared.export/1","links":[]}', 'no links']
	])('refuses %s', (text, message) => {
		expect(() => readFlaredExport(text)).toThrow(message);
	});
});

describe('file kind and size', () => {
	it('picks the reader by extension, then by content', () => {
		expect(fileKind('links.JSON', '')).toBe('json');
		expect(fileKind('links.csv', '{')).toBe('csv');
		expect(fileKind('links', '﻿  {"format":1}')).toBe('json');
		expect(readImportFile('export', 'short,long\nbit.ly/abc,https://e.example').kind).toBe('csv');
	});

	it('limits the file size', () => {
		expect(fileSizeProblem('csv', maxCsvBytes)).toBeNull();
		expect(fileSizeProblem('csv', maxCsvBytes + 1)).toBe(
			'This file is larger than 5 MB. Split it into smaller files.'
		);
		expect(fileSizeProblem('json', maxJsonBytes + 1)).toContain('25 MB');
	});
});

describe('failedRowsCsv', () => {
	it('writes rows the dialog can read again, with formulas defused', () => {
		const text = failedRowsCsv([
			{ row: { ...row('bit.ly/abc'), title: '=SUM(A1)' }, reason: 'Taken, try again.' }
		]);
		const file = readCsvFile(text);
		const columns = guessColumns(file.headers);
		expect(columns).toEqual({ short: { kind: 'url', column: 0 }, destination: 1, title: 2 });
		expect(file.rows[0].cells).toEqual([
			'bit.ly/abc',
			'https://example.com/page',
			"'=SUM(A1)",
			'Taken, try again.'
		]);
	});
});
