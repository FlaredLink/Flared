// SPDX-License-Identifier: AGPL-3.0-only
declare namespace Cloudflare {
	interface Env {
		IDENTITY: D1Database;
		ROUTING: D1Database;
		ANALYTICS_1: D1Database;
		IDENTITY_MIGRATIONS: import('cloudflare:test').D1Migration[];
		ROUTING_MIGRATIONS: import('cloudflare:test').D1Migration[];
		ANALYTICS_MIGRATIONS: import('cloudflare:test').D1Migration[];
	}
}
