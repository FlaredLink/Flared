// SPDX-License-Identifier: AGPL-3.0-only
// Plain-text output for people. Scripts use --json.
import type { LinkAnalytics, Usage, UsageWarning } from '@flared/contracts/analytics';
import type { Domain, DomainPage } from '@flared/contracts/domains';
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

function linkStatus(link: Link): string {
	if (link.blocked) return `blocked (${link.blocked.reason})`;
	return link.enabled ? 'enabled' : 'disabled';
}

export function linkTable(links: ListedLink[]): string {
	if (links.length === 0) return 'No links.';
	return table([
		['SHORT URL', 'CLICKS 30D', 'STATUS', 'DESTINATION'],
		...links.map((link) => [
			link.shortUrl,
			link.clicksLast30Days === null ? '-' : String(link.clicksLast30Days),
			linkStatus(link),
			shorten(link.destination, 60)
		])
	]);
}

export function linkDetails(link: Link): string {
	return table([
		['Short URL', link.shortUrl],
		['Destination', link.destination],
		['Title', link.title ?? '-'],
		['Status', linkStatus(link)],
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
			...(analytics.browsers ? [['Browsers', top(analytics.browsers)]] : []),
			...(analytics.operatingSystems ? [['Systems', top(analytics.operatingSystems)]] : []),
			['As of', utc(analytics.asOf)]
		])
	].join('\n');
}

function used(used: number, limit: number, warning: UsageWarning | undefined): string {
	return `${used} of ${limit}${warning ? ` (${warning.level}%)` : ''}`;
}

export function usageReport(usage: Usage): string {
	const warning = (resource: UsageWarning['resource']) =>
		usage.warnings.find((item) => item.resource === resource);
	const rows = [
		[`Clicks in ${usage.month}`, used(usage.clicks, usage.clickLimit, warning('clicks'))],
		['Active links', used(usage.links.used, usage.links.limit, warning('links'))],
		['Custom domains', used(usage.domains.used, usage.domains.limit, warning('domains'))],
		['History', `${usage.retentionDays} days`],
		['As of', utc(usage.asOf)]
	];
	if (usage.unrecordedSince)
		rows.splice(1, 0, [
			'Not recorded',
			`${usage.unrecordedClicks} clicks since ${utc(usage.unrecordedSince)}`
		]);
	return table(rows);
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

function domainKind(domain: Domain): string {
	if (domain.kind === 'workspace') return 'yours';
	return domain.isDefault ? 'default' : 'shared';
}

export function domainTable(page: DomainPage): string {
	const rows = [
		['HOSTNAME', 'STATUS', 'KIND', 'SETUP'],
		...page.domains.map((domain) => [
			domain.hostname,
			domain.state,
			domainKind(domain),
			domain.setup === 'worker_custom_domain'
				? 'Worker Custom Domain'
				: domain.records
						.map((record) => `${record.type} ${record.name} -> ${record.value}`)
						.join(', ') || '-'
		])
	];
	const problems = page.domains.flatMap((domain) =>
		domain.error ? [`${domain.hostname}: ${domain.error.message}`] : []
	);
	return [
		table(rows),
		'',
		`${page.used} of ${page.limit} domains used.`,
		...(problems.length ? ['', ...problems] : [])
	].join('\n');
}

export function domainDetails(domain: Domain): string {
	const lines = [
		table([
			['Hostname', domain.hostname],
			['Status', domain.state],
			...(domain.error ? [['Problem', domain.error.message]] : []),
			...(domain.activeLinks === null ? [] : [['Active links', String(domain.activeLinks)]]),
			['ID', domain.id]
		])
	];
	if (domain.state !== 'active' && domain.setup === 'worker_custom_domain')
		lines.push(
			'',
			`In the Cloudflare dashboard, add ${domain.hostname} as a Custom Domain of this Flared Worker: Workers & Pages, the Worker, Settings, Domains & Routes, Add, Custom domain. The domain must be on Cloudflare in the same account. Then run flared domain check.`
		);
	else if (domain.state !== 'active' && domain.records.length > 0)
		lines.push(
			'',
			`Create ${domain.records.length === 1 ? 'this DNS record' : 'these DNS records'} where you manage the domain, then run flared domain check:`,
			'',
			table([
				['TYPE', 'NAME', 'VALUE'],
				...domain.records.map((record) => [record.type, record.name, record.value])
			])
		);
	return lines.join('\n');
}
