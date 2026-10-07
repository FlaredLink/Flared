// SPDX-License-Identifier: AGPL-3.0-only
// Site icons for link destinations and referrers. The dashboard asks its own origin for the icon
// of a host name; the server fetches it from that site once and keeps it for every workspace.

const blockedTopLevels = new Set([
	'localhost',
	'local',
	'internal',
	'invalid',
	'test',
	'example',
	'home',
	'lan',
	'corp',
	'arpa',
	'onion'
]);
const labelPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

// The cache key for a site: lowercase ASCII, no trailing dot, no leading "www.". Null for
// anything that is not a public DNS name: an IP address, one label, or a reserved suffix.
export function iconHostname(value: string): string | null {
	const trimmed = value.trim().toLowerCase().replace(/\.$/, '');
	if (!trimmed || trimmed.length > 253 || /[\s/:?#@[\]*\\%]/.test(trimmed)) return null;
	let hostname: string;
	try {
		hostname = new URL(`https://${trimmed}`).hostname;
	} catch {
		return null;
	}
	hostname = hostname.replace(/^www\./, '');
	const labels = hostname.split('.');
	if (labels.length < 2 || hostname.length > 253) return null;
	if (!labels.every((label) => labelPattern.test(label))) return null;
	const top = labels[labels.length - 1];
	if (/^\d+$/.test(top) || blockedTopLevels.has(top)) return null;
	return hostname;
}

// The icon host of an http(s) URL, or null.
export function iconHostnameOfUrl(value: string): string | null {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return null;
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
	return iconHostname(url.hostname);
}
