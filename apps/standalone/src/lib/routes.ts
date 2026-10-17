// SPDX-License-Identifier: AGPL-3.0-only
export const appRoutes = {
	setup: '/setup',
	login: '/app/login',
	app: '/app',
	domains: '/app/domains',
	automations: '/app/automations',
	settings: '/app/settings',
	consent: '/app/oauth/consent',
	invite: '/app/invite',
	reset: '/app/reset'
} as const;

// Each Settings section has its own address. Account sections apply to the person; workspace
// sections apply to the workspace.
export const settingsRoutes = {
	account: '/app/settings/account',
	security: '/app/settings/security',
	preferences: '/app/settings/preferences',
	workspace: '/app/settings/workspace',
	members: '/app/settings/members',
	limits: '/app/settings/limits',
	updates: '/app/settings/updates',
	tokens: '/app/settings/tokens',
	webhooks: '/app/settings/webhooks',
	apps: '/app/settings/apps'
} as const;

export function linkRoute(id: string): string {
	return `/app/links/${encodeURIComponent(id)}`;
}
