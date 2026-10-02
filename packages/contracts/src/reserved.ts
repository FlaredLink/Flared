// SPDX-License-Identifier: AGPL-3.0-only
// One list for every edition: standalone serves its app and short links on one host, so no
// slug may take a path that a site, app, API, or static asset uses now or may use later.

// First path segments owned by the application. Paths below them are reserved too.
export const reservedSegments: readonly string[] = [
	'pricing',
	'privacy',
	'terms',
	'refunds',
	'docs',
	'site',
	'app',
	'api',
	'setup',
	'v1',
	'brand',
	'brands',
	'_app',
	'.well-known'
];

// Exact root files. Slugs cannot contain a dot, so these matter for routing, not validation.
export const reservedFiles: readonly string[] = [
	'robots.txt',
	'sitemap.xml',
	'llms.txt',
	'auth.md',
	'favicon.ico',
	'favicon.svg',
	'landscape.svg',
	'sample-qr.svg',
	'social-card.png',
	'social-card.svg'
];

// True when a request path belongs to the application rather than to a short link.
export function isReservedPath(pathname: string): boolean {
	if (pathname === '/') return true;
	const [first = ''] = pathname.slice(1).split('/');
	return reservedSegments.includes(first) || reservedFiles.includes(first);
}

export function isReservedSlug(slug: string): boolean {
	return reservedSegments.includes(slug);
}
