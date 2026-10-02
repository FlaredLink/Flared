// SPDX-License-Identifier: AGPL-3.0-only
// Edge side of click analytics: decide whether a redirect counts, and build the minimized event.
// Only coarse fields leave this module; the user agent, IP, and full referrer stay here.
import {
	clickEventSchemaVersion,
	normalizeCountry,
	normalizeReferrer,
	type ClickEvent,
	type DeviceCategory
} from '@flared/contracts/analytics';

// Change the version with the list, so counts can be explained against the rules in force.
export const automationClassifierVersion = 1;

// Best effort: crawlers, link-preview fetchers, and HTTP libraries. Unknown automation counts.
// "cubot" is a phone brand, so a bare "bot" must not follow "cu".
const automatedAgents = [
	/(?<!cu)bot\b/i,
	/crawl/i,
	/spider/i,
	/slurp/i,
	/facebookexternalhit|facebookcatalog|meta-externalagent/i,
	/slack-imgproxy|slackbot/i,
	/whatsapp\//i,
	/skypeuripreview/i,
	/mastodon\//i,
	/snap url preview/i,
	/embedly|iframely|vkshare|metainspector/i,
	/google-inspectiontool|googleother|google-read-aloud/i,
	/headlesschrome|phantomjs|lighthouse|pagespeed/i,
	/^(?:curl|wget|httpie|python-requests|python-urllib|python-httpx|aiohttp|go-http-client|okhttp|axios|node-fetch|undici|got|libwww-perl|java|bun|deno|postmanruntime|insomnia)\b/i
];

export function isAutomated(userAgent: string | null): boolean {
	const agent = userAgent?.trim() ?? '';
	if (!agent) return true;
	return automatedAgents.some((pattern) => pattern.test(agent));
}

// iPadOS sends a desktop Safari user agent, so most iPads count as desktop.
export function deviceCategory(userAgent: string | null): DeviceCategory {
	const agent = userAgent ?? '';
	if (/ipad|tablet|kindle|silk|playbook|^(?=.*android)(?!.*mobile)/i.test(agent)) return 'tablet';
	if (/mobi|iphone|ipod|windows phone|android/i.test(agent)) return 'mobile';
	if (/windows nt|macintosh|x11|cros/i.test(agent)) return 'desktop';
	return 'unknown';
}

export interface ClickTarget {
	tenantId: string;
	linkId: string;
	analyticsShardId: string;
}

// Cloudflare adds request.cf at the edge; elsewhere it is absent and the country is unknown.
function countryOf(request: Request): string {
	const cf: unknown = Reflect.get(request, 'cf');
	return normalizeCountry(
		typeof cf === 'object' && cf !== null ? Reflect.get(cf, 'country') : null
	);
}

export function buildClickEvent(request: Request, target: ClickTarget, now: number): ClickEvent {
	const userAgent = request.headers.get('user-agent');
	return {
		schemaVersion: clickEventSchemaVersion,
		eventId: crypto.randomUUID(),
		tenantId: target.tenantId,
		analyticsShardId: target.analyticsShardId,
		linkId: target.linkId,
		kind: 'production',
		occurredAt: now,
		country: countryOf(request),
		deviceCategory: deviceCategory(userAgent),
		referrerHostname: normalizeReferrer(request.headers.get('referer'))
	};
}
