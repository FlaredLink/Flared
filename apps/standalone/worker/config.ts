// SPDX-License-Identifier: AGPL-3.0-only
// The deployment configuration of a standalone Worker, validated once per request. Missing or
// invalid values fail closed with an operator page that names them and never shows a value.
import type { ClickEvent } from '@flared/contracts/analytics';
import type { AnalyticsShards } from '@flared/server/shards';
import { keyedHash } from '@flared/server/auth/limits';
import type { ClickSink } from '@flared/server/redirect';
import { defaultSourceUrl } from '../src/lib/source';

export interface StandaloneEnv {
	ASSETS: Pick<Fetcher, 'fetch'>;
	IDENTITY?: D1Database;
	ROUTING?: D1Database;
	ANALYTICS_1?: D1Database;
	// The click Queue producer.
	CLICKS?: { send(message: ClickEvent): Promise<unknown> };
	// Secrets: the app origin (an https: origin with no path), the auth signing secret, and the
	// one-time setup secret.
	APP_ORIGIN?: string;
	AUTH_SECRET?: string;
	SETUP_SECRET?: string;
	// Where the source of this version is published (AGPL section 13).
	SOURCE_URL?: string;
}

export interface StandaloneConfig {
	origin: string;
	host: string;
	secret: string;
	// Keys request budgets, derived from the auth secret.
	rateLimitSecret: string;
	setupSecret: string | null;
	sourceUrl: string;
	identity: D1Database;
	routing: D1Database;
	shards: AnalyticsShards;
	analyticsShardId: string;
	clicks: ClickSink | undefined;
}

export type ConfigProblem = 'APP_ORIGIN' | 'AUTH_SECRET' | 'DATABASES';

function database(value: D1Database | undefined): D1Database | null {
	return value && typeof value.prepare === 'function' ? value : null;
}

// An https: origin with no path, or an explicit loopback origin for local development.
export function parseAppOrigin(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return null;
	}
	const loopback =
		url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
	if (url.origin !== value || (url.protocol !== 'https:' && !loopback)) return null;
	return url.origin;
}

function sourceUrl(value: unknown): string {
	if (typeof value !== 'string' || !value) return defaultSourceUrl;
	try {
		const url = new URL(value);
		return url.protocol === 'https:' ? url.toString().replace(/\/$/, '') : defaultSourceUrl;
	} catch {
		return defaultSourceUrl;
	}
}

export async function readConfig(
	env: StandaloneEnv
): Promise<{ ok: true; config: StandaloneConfig } | { ok: false; problem: ConfigProblem }> {
	const origin = parseAppOrigin(env.APP_ORIGIN);
	if (!origin) return { ok: false, problem: 'APP_ORIGIN' };
	const secret = env.AUTH_SECRET;
	if (typeof secret !== 'string' || secret.length < 32 || secret.length > 256)
		return { ok: false, problem: 'AUTH_SECRET' };
	const identity = database(env.IDENTITY);
	const routing = database(env.ROUTING);
	const analytics = database(env.ANALYTICS_1);
	if (!identity || !routing || !analytics) return { ok: false, problem: 'DATABASES' };
	const setup = typeof env.SETUP_SECRET === 'string' && env.SETUP_SECRET ? env.SETUP_SECRET : null;
	const queue = env.CLICKS;
	return {
		ok: true,
		config: {
			origin,
			host: new URL(origin).host,
			secret,
			rateLimitSecret: await keyedHash(secret, 'flared-standalone:rate-limit-key'),
			setupSecret: setup,
			sourceUrl: sourceUrl(env.SOURCE_URL),
			identity,
			routing,
			shards: { 'analytics-1': analytics },
			analyticsShardId: 'analytics-1',
			clicks:
				queue && typeof queue.send === 'function'
					? {
							async send(event) {
								await queue.send(event);
							}
						}
					: undefined
		}
	};
}
