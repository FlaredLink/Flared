// SPDX-License-Identifier: AGPL-3.0-only
// The deployment configuration of a standalone Worker, validated once per request. Invalid
// values fail closed with an operator page that names them and never shows a value. The
// deployment may leave out APP_ORIGIN and AUTH_SECRET: the app origin is then the one stored at
// setup, and the auth secret is one the Worker made and stored at its first request.
import type { ClickEvent } from '@flared/contracts/analytics';
import { installationAuthSecret } from '@flared/data/setup';
import type { AnalyticsShards } from '@flared/server/shards';
import { keyedHash } from '@flared/server/auth/limits';
import { createLinkPasswords, type LinkPasswords } from '@flared/server/link-passwords';
import type { PreviewImageStore } from '@flared/server/preview-images';
import type { AttemptLimiter, ClickSink } from '@flared/server/redirect';
import { defaultSourceUrl } from '../src/lib/source';

export interface StandaloneEnv {
	ASSETS: Pick<Fetcher, 'fetch'>;
	IDENTITY?: D1Database;
	ROUTING?: D1Database;
	ANALYTICS_1?: D1Database;
	// The click Queue producer.
	CLICKS?: { send(message: ClickEvent): Promise<unknown> };
	// Secrets: the app origin (an https: origin with no path) and the auth signing secret, both
	// optional, and the setup secret that the owner types once at /setup.
	APP_ORIGIN?: string;
	AUTH_SECRET?: string;
	SETUP_SECRET?: string;
	// Where the source of this version is published (AGPL section 13).
	SOURCE_URL?: string;
	// The rate limiting binding for tries of a link password. Without it, no link password can
	// be set, and a link that has one does not open.
	LINK_PASSWORD_ATTEMPTS?: AttemptLimiter;
	// An R2 bucket for link card images, which the operator adds (docs/self-hosting/link-previews.md).
	// Without it, link cards have a title and description but no image.
	PREVIEW_IMAGES?: PreviewImageStore;
}

export interface DeploymentConfig {
	// The APP_ORIGIN secret, or null when the deployment leaves it out.
	configuredOrigin: string | null;
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
	// The link password key comes from the auth secret, so a new auth secret makes every link
	// password stop working until it is set again.
	linkPasswords: { keys: LinkPasswords; attempts: AttemptLimiter } | undefined;
	previewImages: PreviewImageStore | undefined;
}

// The configuration of one request, with the app origin resolved.
export interface StandaloneConfig extends DeploymentConfig {
	origin: string;
	host: string;
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

// The stored secret never changes, so each isolate reads it once per database.
const storedSecrets = new WeakMap<D1Database, Promise<string>>();

function storedAuthSecret(identity: D1Database): Promise<string> {
	let secret = storedSecrets.get(identity);
	if (!secret) {
		secret = installationAuthSecret(identity, Date.now());
		storedSecrets.set(identity, secret);
		secret.catch(() => storedSecrets.delete(identity));
	}
	return secret;
}

const isSet = (value: unknown): value is string => typeof value === 'string' && value !== '';

// Rejects when the stored secret cannot be read or made.
export async function readConfig(
	env: StandaloneEnv
): Promise<{ ok: true; config: DeploymentConfig } | { ok: false; problem: ConfigProblem }> {
	const configuredOrigin = isSet(env.APP_ORIGIN) ? parseAppOrigin(env.APP_ORIGIN) : null;
	if (isSet(env.APP_ORIGIN) && !configuredOrigin) return { ok: false, problem: 'APP_ORIGIN' };
	if (isSet(env.AUTH_SECRET) && (env.AUTH_SECRET.length < 32 || env.AUTH_SECRET.length > 256))
		return { ok: false, problem: 'AUTH_SECRET' };
	const identity = database(env.IDENTITY);
	const routing = database(env.ROUTING);
	const analytics = database(env.ANALYTICS_1);
	if (!identity || !routing || !analytics) return { ok: false, problem: 'DATABASES' };
	const secret = isSet(env.AUTH_SECRET) ? env.AUTH_SECRET : await storedAuthSecret(identity);
	const setup = isSet(env.SETUP_SECRET) ? env.SETUP_SECRET : null;
	const queue = env.CLICKS;
	const attempts = env.LINK_PASSWORD_ATTEMPTS;
	const images = env.PREVIEW_IMAGES;
	return {
		ok: true,
		config: {
			configuredOrigin,
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
					: undefined,
			linkPasswords:
				attempts && typeof attempts.limit === 'function'
					? { keys: createLinkPasswords(secret), attempts }
					: undefined,
			previewImages: images && typeof images.put === 'function' ? images : undefined
		}
	};
}

// The APP_ORIGIN secret wins; then the origin stored at setup. Before setup, the request's own
// origin: only a host that routes to this Worker reaches it, and setup still needs the setup
// secret. Null without a request, or for a plain http: request.
export function appOrigin(
	config: DeploymentConfig,
	stored: string | null,
	request: URL | null
): string | null {
	return config.configuredOrigin ?? stored ?? (request ? parseAppOrigin(request.origin) : null);
}

export function withOrigin(config: DeploymentConfig, origin: string): StandaloneConfig {
	return { ...config, origin, host: new URL(origin).host };
}
