// SPDX-License-Identifier: AGPL-3.0-only
export const appRoutes = {
	setup: '/setup',
	login: '/app/login',
	app: '/app',
	domains: '/app/domains',
	settings: '/app/settings',
	consent: '/app/oauth/consent'
} as const;

export function linkRoute(id: string): string {
	return `/app/links/${encodeURIComponent(id)}`;
}
