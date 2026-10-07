// SPDX-License-Identifier: AGPL-3.0-only
// Click events on the Queue and the analytics responses of the API. An event carries only
// coarse fields derived at the edge: no IP address, user agent, full referrer, or destination.

export const clickEventSchemaVersion = 1;
// Events older than the Queue replay horizon are refused, so a late replay cannot count.
export const clickEventMaxAgeMs = 48 * 60 * 60 * 1000;
export const clickEventMaxSkewMs = 5 * 60 * 1000;

export const deviceCategories = ['desktop', 'mobile', 'tablet', 'unknown'] as const;
export type DeviceCategory = (typeof deviceCategories)[number];

// Families only: no version, engine, or device model. unknown means the request sent no user
// agent; other means a user agent outside the list.
export const browserFamilies = [
	'chrome',
	'safari',
	'firefox',
	'edge',
	'samsung',
	'opera',
	'other',
	'unknown'
] as const;
export type BrowserFamily = (typeof browserFamilies)[number];

export const osFamilies = [
	'ios',
	'android',
	'windows',
	'macos',
	'linux',
	'chromeos',
	'other',
	'unknown'
] as const;
export type OsFamily = (typeof osFamilies)[number];

export type ClickEventKind = 'production' | 'test';

export interface ClickEvent {
	schemaVersion: typeof clickEventSchemaVersion;
	eventId: string;
	tenantId: string;
	analyticsShardId: string;
	linkId: string;
	kind: ClickEventKind;
	checkId?: string;
	occurredAt: number;
	// ISO 3166-1 alpha-2 code, or unknown.
	country: string;
	deviceCategory: DeviceCategory;
	// Lowercase host name of the referring page, or unknown.
	referrerHostname: string;
	// Absent from events sent before browser and OS recording, which count without them.
	browser?: BrowserFamily;
	os?: OsFamily;
}

const idPattern = /^[A-Za-z0-9_-]{1,64}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const shardIdPattern = /^[a-z0-9-]{1,63}$/;
const countryPattern = /^[A-Z]{2}$/;
const hostnamePattern =
	/^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

// XX and T1 are Cloudflare's codes for an unknown country and for Tor.
export function normalizeCountry(value: unknown): string {
	if (typeof value !== 'string' || !countryPattern.test(value)) return 'unknown';
	return value === 'XX' || value === 'T1' ? 'unknown' : value;
}

// Only the host name of an http(s) referrer is kept. A host without a dot (localhost, an
// intranet name) and the reserved bucket names become unknown.
export function normalizeReferrer(value: string | null): string {
	if (!value) return 'unknown';
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return 'unknown';
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'unknown';
	const hostname = url.hostname
		.toLowerCase()
		.replace(/\.$/, '')
		.replace(/^www\./, '');
	return hostnamePattern.test(hostname) ? hostname : 'unknown';
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDevice(value: unknown): value is DeviceCategory {
	return typeof value === 'string' && deviceCategories.some((device) => device === value);
}

function isBrowser(value: unknown): value is BrowserFamily {
	return typeof value === 'string' && browserFamilies.some((browser) => browser === value);
}

function isOs(value: unknown): value is OsFamily {
	return typeof value === 'string' && osFamilies.some((os) => os === value);
}

// Returns null for any event that the consumer must not count.
export function parseClickEvent(value: unknown): ClickEvent | null {
	if (!isRecord(value)) return null;
	const allowed = [
		'schemaVersion',
		'eventId',
		'tenantId',
		'analyticsShardId',
		'linkId',
		'kind',
		'checkId',
		'occurredAt',
		'country',
		'deviceCategory',
		'referrerHostname',
		'browser',
		'os'
	];
	if (Object.keys(value).some((key) => !allowed.includes(key))) return null;
	const {
		schemaVersion,
		eventId,
		tenantId,
		analyticsShardId,
		linkId,
		kind,
		checkId,
		occurredAt,
		country,
		deviceCategory,
		referrerHostname,
		browser,
		os
	} = value;
	if (schemaVersion !== clickEventSchemaVersion) return null;
	if (typeof eventId !== 'string' || !uuidPattern.test(eventId)) return null;
	if (typeof tenantId !== 'string' || !idPattern.test(tenantId)) return null;
	if (typeof linkId !== 'string' || !idPattern.test(linkId)) return null;
	if (typeof analyticsShardId !== 'string' || !shardIdPattern.test(analyticsShardId)) return null;
	if (kind !== 'production' && kind !== 'test') return null;
	if (kind === 'production' && checkId !== undefined) return null;
	if (kind === 'test' && (typeof checkId !== 'string' || !idPattern.test(checkId))) return null;
	if (typeof occurredAt !== 'number' || !Number.isSafeInteger(occurredAt) || occurredAt < 0)
		return null;
	if (
		typeof country !== 'string' ||
		(country !== 'unknown' && normalizeCountry(country) !== country)
	)
		return null;
	if (!isDevice(deviceCategory)) return null;
	if (
		typeof referrerHostname !== 'string' ||
		(referrerHostname !== 'unknown' && !hostnamePattern.test(referrerHostname))
	)
		return null;
	if (browser !== undefined && !isBrowser(browser)) return null;
	if (os !== undefined && !isOs(os)) return null;
	return {
		schemaVersion,
		eventId,
		tenantId,
		analyticsShardId,
		linkId,
		kind,
		...(typeof checkId === 'string' ? { checkId } : {}),
		occurredAt,
		country,
		deviceCategory,
		referrerHostname,
		...(browser !== undefined ? { browser } : {}),
		...(os !== undefined ? { os } : {})
	};
}

// UTC calendar day (YYYY-MM-DD) and month (YYYY-MM) of a time in milliseconds.
export function utcDay(time: number): string {
	return new Date(time).toISOString().slice(0, 10);
}

export function utcMonth(time: number): string {
	return new Date(time).toISOString().slice(0, 7);
}

export const dayPattern = /^\d{4}-\d{2}-\d{2}$/;

// The first day a tenant may still read: today and the retentionDays - 1 days before it.
export function oldestRetainedDay(now: number, retentionDays: number): string {
	return utcDay(now - (retentionDays - 1) * 86400000);
}

export interface DailyClicks {
	day: string;
	clicks: number;
}

export interface DimensionClicks {
	value: string;
	clicks: number;
}

export interface LinkAnalytics {
	linkId: string;
	from: string;
	to: string;
	total: number;
	// One entry for every day in the range, including days without clicks.
	days: DailyClicks[];
	countries: DimensionClicks[];
	devices: DimensionClicks[];
	// At most 50 host names per link and day; the rest count under "other".
	referrers: DimensionClicks[];
	// Clicks recorded before browser and OS recording have no entry, so these can sum to less
	// than total. Servers before that release leave both out.
	browsers?: DimensionClicks[];
	operatingSystems?: DimensionClicks[];
	asOf: string;
}

export interface LimitUsage {
	used: number;
	limit: number;
}

export type UsageResource = 'clicks' | 'links' | 'domains';

export type UsageLevel = 80 | 100;

export interface UsageWarning {
	resource: UsageResource;
	level: UsageLevel;
}

export interface Usage {
	month: string;
	// Clicks recorded this UTC month and the monthly allowance.
	clicks: number;
	clickLimit: number;
	// Clicks after the allowance was full: counted, never recorded.
	unrecordedClicks: number;
	unrecordedSince: string | null;
	links: LimitUsage;
	domains: LimitUsage;
	retentionDays: number;
	// One entry for each resource at 80% or more of its limit.
	warnings: UsageWarning[];
	asOf: string;
}

// The highest threshold reached, or null below 80%. A limit of 0 never warns: the resource
// is turned off, not running out.
export function usageLevel(used: number, limit: number): UsageLevel | null {
	if (limit <= 0) return null;
	if (used >= limit) return 100;
	if (used * 5 >= limit * 4) return 80;
	return null;
}

export function usageWarnings(usage: {
	clicks: number;
	clickLimit: number;
	links: LimitUsage;
	domains: LimitUsage;
}): UsageWarning[] {
	const warnings: UsageWarning[] = [];
	const levels: [UsageResource, UsageLevel | null][] = [
		['clicks', usageLevel(usage.clicks, usage.clickLimit)],
		['links', usageLevel(usage.links.used, usage.links.limit)],
		['domains', usageLevel(usage.domains.used, usage.domains.limit)]
	];
	for (const [resource, level] of levels) if (level) warnings.push({ resource, level });
	return warnings;
}

// Shape checks for API responses read by clients.
function isCount(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}
function isRows<T>(value: unknown, key: 'day' | 'value'): value is T[] {
	return (
		Array.isArray(value) &&
		value.every(
			(row) =>
				typeof row === 'object' &&
				row !== null &&
				typeof (row as Record<string, unknown>)[key] === 'string' &&
				isCount((row as Record<string, unknown>).clicks)
		)
	);
}

export function isLinkAnalytics(value: unknown): value is LinkAnalytics {
	if (typeof value !== 'object' || value === null) return false;
	const analytics = value as Record<string, unknown>;
	return (
		typeof analytics.linkId === 'string' &&
		typeof analytics.from === 'string' &&
		typeof analytics.to === 'string' &&
		isCount(analytics.total) &&
		isRows<DailyClicks>(analytics.days, 'day') &&
		isRows<DimensionClicks>(analytics.countries, 'value') &&
		isRows<DimensionClicks>(analytics.devices, 'value') &&
		isRows<DimensionClicks>(analytics.referrers, 'value') &&
		(analytics.browsers === undefined || isRows<DimensionClicks>(analytics.browsers, 'value')) &&
		(analytics.operatingSystems === undefined ||
			isRows<DimensionClicks>(analytics.operatingSystems, 'value')) &&
		typeof analytics.asOf === 'string'
	);
}

export function isUsage(value: unknown): value is Usage {
	if (typeof value !== 'object' || value === null) return false;
	const usage = value as Record<string, unknown>;
	return (
		typeof usage.month === 'string' &&
		isCount(usage.clicks) &&
		isCount(usage.clickLimit) &&
		isCount(usage.unrecordedClicks) &&
		(usage.unrecordedSince === null || typeof usage.unrecordedSince === 'string') &&
		isLimitUsage(usage.links) &&
		isLimitUsage(usage.domains) &&
		isCount(usage.retentionDays) &&
		Array.isArray(usage.warnings) &&
		usage.warnings.every(isUsageWarning) &&
		typeof usage.asOf === 'string'
	);
}

function isLimitUsage(value: unknown): value is LimitUsage {
	if (typeof value !== 'object' || value === null) return false;
	const usage = value as Record<string, unknown>;
	return isCount(usage.used) && isCount(usage.limit);
}

function isUsageWarning(value: unknown): value is UsageWarning {
	if (typeof value !== 'object' || value === null) return false;
	const warning = value as Record<string, unknown>;
	return (
		(warning.resource === 'clicks' ||
			warning.resource === 'links' ||
			warning.resource === 'domains') &&
		(warning.level === 80 || warning.level === 100)
	);
}
