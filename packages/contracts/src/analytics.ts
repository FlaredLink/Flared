// SPDX-License-Identifier: AGPL-3.0-only
// Click events on the Queue and the analytics responses of the API. An event carries only
// coarse fields derived at the edge: no IP address, user agent, full referrer, or destination.

export const clickEventSchemaVersion = 1;
// Events older than the Queue replay horizon are refused, so a late replay cannot count.
export const clickEventMaxAgeMs = 48 * 60 * 60 * 1000;
export const clickEventMaxSkewMs = 5 * 60 * 1000;

export const deviceCategories = ['desktop', 'mobile', 'tablet', 'unknown'] as const;
export type DeviceCategory = (typeof deviceCategories)[number];

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
		'referrerHostname'
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
		referrerHostname
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
		referrerHostname
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
	asOf: string;
}

export interface Usage {
	month: string;
	clicks: number;
	clickLimit: number;
	asOf: string;
}
