// SPDX-License-Identifier: AGPL-3.0-only
// The workspace limits as GET /api/settings/limits returns them (worker/limits.ts).
import type { AuthService } from '@flared/server/web';

export interface Limits {
	activeLinkLimit: number;
	monthlyClickLimit: number;
	retentionDays: number;
	domainLimit: number;
	memberLimit: number;
}

export interface LimitsView {
	limits: Limits;
	// The new limits are stored but not yet in both the routing and analytics databases.
	pending: boolean;
	analyticsBytes: number | null;
	bounds: Record<keyof Limits, { min: number; max: number }>;
}

export const limitFields: { key: keyof Limits; label: string; unit: string }[] = [
	{ key: 'activeLinkLimit', label: 'Active links', unit: 'links' },
	{ key: 'monthlyClickLimit', label: 'Recorded clicks a month', unit: 'clicks' },
	{ key: 'retentionDays', label: 'Days of click history', unit: 'days' },
	{ key: 'domainLimit', label: 'Own domains', unit: 'domains' },
	{ key: 'memberLimit', label: 'People, open invites included', unit: 'people' }
];

function count(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function fields(value: unknown): Record<string, unknown> {
	return typeof value === 'object' && value !== null
		? Object.fromEntries(Object.entries(value))
		: {};
}

function range(value: unknown): { min: number; max: number } | null {
	const { min, max } = fields(value);
	return count(min) && count(max) ? { min, max } : null;
}

export function toLimitsView(value: unknown): LimitsView | null {
	const body = fields(value);
	const limits = fields(body.limits);
	const bounds = fields(body.bounds);
	const { activeLinkLimit, monthlyClickLimit, retentionDays, domainLimit, memberLimit } = limits;
	const ranges = {
		activeLinkLimit: range(bounds.activeLinkLimit),
		monthlyClickLimit: range(bounds.monthlyClickLimit),
		retentionDays: range(bounds.retentionDays),
		domainLimit: range(bounds.domainLimit),
		memberLimit: range(bounds.memberLimit)
	};
	if (
		typeof body.pending !== 'boolean' ||
		!count(activeLinkLimit) ||
		!count(monthlyClickLimit) ||
		!count(retentionDays) ||
		!count(domainLimit) ||
		!count(memberLimit) ||
		!ranges.activeLinkLimit ||
		!ranges.monthlyClickLimit ||
		!ranges.retentionDays ||
		!ranges.domainLimit ||
		!ranges.memberLimit
	)
		return null;
	return {
		limits: { activeLinkLimit, monthlyClickLimit, retentionDays, domainLimit, memberLimit },
		pending: body.pending,
		analyticsBytes: count(body.analyticsBytes) ? body.analyticsBytes : null,
		bounds: {
			activeLinkLimit: ranges.activeLinkLimit,
			monthlyClickLimit: ranges.monthlyClickLimit,
			retentionDays: ranges.retentionDays,
			domainLimit: ranges.domainLimit,
			memberLimit: ranges.memberLimit
		}
	};
}

export async function readLimits(
	service: AuthService,
	headers: Headers,
	origin: string
): Promise<LimitsView | null> {
	const forwarded = new Headers();
	const cookie = headers.get('cookie');
	if (cookie !== null) forwarded.set('cookie', cookie);
	const response = await service.fetch(
		new Request(new URL('/api/settings/limits', origin), { headers: forwarded })
	);
	if (!response.ok) return null;
	return toLimitsView(await response.json().catch(() => null));
}
