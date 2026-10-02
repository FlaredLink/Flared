// SPDX-License-Identifier: AGPL-3.0-only
declare namespace Cloudflare {
	interface Env {
		UNCONFIGURED_IDENTITY: D1Database;
		SINGLE_IDENTITY: D1Database;
		MULTI_IDENTITY: D1Database;
		ROUTING: D1Database;
		LINKS_IDENTITY: D1Database;
		LINKS_ROUTING: D1Database;
		REDIRECT_ROUTING: D1Database;
		BROKEN_ROUTING: D1Database;
		PASSKEY_IDENTITY: D1Database;
		TENANCY_ANALYTICS: D1Database;
		LINKS_ANALYTICS: D1Database;
		ANALYTICS: D1Database;
		ANALYTICS_IDENTITY: D1Database;
		ANALYTICS_ROUTING: D1Database;
		TOKENS_IDENTITY: D1Database;
		TOKENS_ROUTING: D1Database;
		TOKENS_ANALYTICS: D1Database;
		CLIENT_IDENTITY: D1Database;
		CLIENT_ROUTING: D1Database;
		CLIENT_ANALYTICS: D1Database;
		IDENTITY_MIGRATIONS: import('cloudflare:test').D1Migration[];
		ROUTING_MIGRATIONS: import('cloudflare:test').D1Migration[];
		ANALYTICS_MIGRATIONS: import('cloudflare:test').D1Migration[];
	}
}
