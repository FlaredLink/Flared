// SPDX-License-Identifier: AGPL-3.0-only
// A workspace export: the pages of /v1/export/* and the file the dashboard and the CLI write
// from them. A future import reads the file by its format.
import { dayPattern } from './analytics';
import { isLink, type Link } from './links';

export const exportFormat = 'flared.export/1';
export const exportLinkPageSize = 1000;
export const exportAnalyticsPageSize = 10000;

export const exportDimensions = ['country', 'device', 'referrer'] as const;
export type ExportDimension = (typeof exportDimensions)[number];

export interface ExportLinkPage {
	links: Link[];
	nextCursor: string | null;
}

export interface ExportDailyTotal {
	linkId: string;
	day: string;
	clicks: number;
}

export interface ExportDailyDimension {
	linkId: string;
	day: string;
	dimension: ExportDimension;
	value: string;
	clicks: number;
}

// Rows from the first retained day on. from and retentionDays describe the window when the page
// was read.
export interface ExportAnalyticsPage<Row> {
	from: string;
	retentionDays: number;
	rows: Row[];
	nextCursor: string | null;
}

export type ExportTotalsPage = ExportAnalyticsPage<ExportDailyTotal>;
export type ExportDimensionsPage = ExportAnalyticsPage<ExportDailyDimension>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isDay(value: unknown): value is string {
	return typeof value === 'string' && dayPattern.test(value);
}

function isCursor(value: unknown): value is string | null {
	return value === null || typeof value === 'string';
}

export function isExportLinkPage(value: unknown): value is ExportLinkPage {
	return (
		isRecord(value) &&
		Array.isArray(value.links) &&
		value.links.every(isLink) &&
		isCursor(value.nextCursor)
	);
}

function isAnalyticsPage(value: unknown, isRow: (row: unknown) => boolean): boolean {
	return (
		isRecord(value) &&
		isDay(value.from) &&
		isCount(value.retentionDays) &&
		Array.isArray(value.rows) &&
		value.rows.every(isRow) &&
		isCursor(value.nextCursor)
	);
}

function isTotal(value: unknown): value is ExportDailyTotal {
	return (
		isRecord(value) && typeof value.linkId === 'string' && isDay(value.day) && isCount(value.clicks)
	);
}

function isDimension(value: unknown): value is ExportDailyDimension {
	return (
		isTotal(value) &&
		isRecord(value) &&
		exportDimensions.some((dimension) => dimension === value.dimension) &&
		typeof value.value === 'string'
	);
}

export function isExportTotalsPage(value: unknown): value is ExportTotalsPage {
	return isAnalyticsPage(value, isTotal);
}

export function isExportDimensionsPage(value: unknown): value is ExportDimensionsPage {
	return isAnalyticsPage(value, isDimension);
}
