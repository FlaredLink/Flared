// SPDX-License-Identifier: AGPL-3.0-only
// Plain-text output for people. Scripts use --json.
import type { LinkAnalytics, Usage } from '@flared/contracts/analytics';
import type { Link, ListedLink } from '@flared/contracts/links';
import type { ApiIdentity } from '@flared/contracts/tokens';

export function table(rows: string[][]): string {
	const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
	return rows
		.map((row) =>
			row
				.map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column])))
				.join('  ')
		)
		.join('\n');
}

function shorten(text: string, length: number): string {
	return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

function utc(iso: string): string {
	return `${iso.slice(0, 16).replace('T', ' ')} UTC`;
}

export function linkTable(links: ListedLink[]): string {
	if (links.length === 0) return 'No links.';
	return table([
		['SHORT URL', 'CLICKS 30D', 'STATUS', 'DESTINATION'],
		...links.map((link) => [
			link.shortUrl,
			link.clicksLast30Days === null ? '-' : String(link.clicksLast30Days),
			link.enabled ? 'enabled' : 'disabled',
			shorten(link.destination, 60)
		])
	]);
}

export function linkDetails(link: Link): string {
	return table([
		['Short URL', link.shortUrl],
		['Destination', link.destination],
		['Title', link.title ?? '-'],
		['Status', link.enabled ? 'enabled' : 'disabled'],
		['Created', utc(link.createdAt)],
		['Updated', utc(link.updatedAt)],
		['ID', link.id]
	]);
}

function top(rows: { value: string; clicks: number }[]): string {
	if (rows.length === 0) return '-';
	return [...rows]
		.sort((a, b) => b.clicks - a.clicks)
		.slice(0, 5)
		.map((row) => `${row.value} ${row.clicks}`)
		.join(', ');
}

export function analyticsReport(link: Link, analytics: LinkAnalytics): string {
	const clicks = analytics.total === 1 ? '1 click' : `${analytics.total} clicks`;
	const days = analytics.days.filter((day) => day.clicks > 0);
	return [
		`${link.shortUrl}: ${clicks} from ${analytics.from} to ${analytics.to}`,
		'',
		days.length
			? table([['DAY', 'CLICKS'], ...days.map((day) => [day.day, String(day.clicks)])])
			: 'No clicks in this range.',
		'',
		table([
			['Countries', top(analytics.countries)],
			['Referrers', top(analytics.referrers)],
			['Devices', top(analytics.devices)],
			['As of', utc(analytics.asOf)]
		])
	].join('\n');
}

export function usageReport(usage: Usage): string {
	return `${usage.clicks} of ${usage.clickLimit} clicks recorded in ${usage.month} (as of ${utc(usage.asOf)}).`;
}

export function identityReport(identity: ApiIdentity, apiUrl: string): string {
	const rows =
		identity.kind === 'token'
			? [
					['Token', `${identity.token.name} (${identity.token.start}…)`],
					['Expires', identity.token.expiresAt ? utc(identity.token.expiresAt) : 'never']
				]
			: [['Session', 'browser session']];
	return table([...rows, ['Scopes', identity.scopes.join(', ')], ['API', apiUrl]]);
}
