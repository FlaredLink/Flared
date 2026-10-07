// SPDX-License-Identifier: AGPL-3.0-only
// The one Worker of a standalone installation: app pages, API, auth, OAuth, MCP, short-link
// redirects, the click Queue, and the scheduled jobs. It decides by host. The app host
// (APP_ORIGIN) serves the reserved paths; every other host and every other path is a short
// link. No request header chooses the app origin.
import sveltekit from 'sveltekit-worker';
import { isReservedPath } from '@flared/contracts/reserved';
import { readInstallationStatus, type InstallationStatus } from '@flared/data/setup';
import { deleteAccount, type AccountDeletionEdition } from '@flared/server/account';
import { createApi, type ApiAuthentication } from '@flared/server/api';
import { apiAuthenticator, sessionPrincipal, unavailable } from '@flared/server/api/compose';
import { createClickConsumer } from '@flared/server/analytics';
import { createTokenAuth } from '@flared/server/auth/api-tokens';
import {
	createOwnerAuthRoutes,
	ownerSignInMethods,
	ownerSourceLimited
} from '@flared/server/auth/owner';
import { runDeletions } from '@flared/server/deletion';
import {
	aiCatalogDocument,
	handleMcp,
	handleOAuth,
	protectedResourceDocument,
	serverCardDocument
} from '@flared/server/oauth/handler';
import { isOAuthPath } from '@flared/server/oauth';
import { createDeadLetterConsumer } from '@flared/server/operations';
import { createRedirectHandler } from '@flared/server/redirect';
import { handleSetup } from '@flared/server/setup';
import type { AuthService } from '@flared/server/web';
import { forwardAuthRoute, sharedAuthMethods } from '@flared/server/web/auth';
import { readConfig, type StandaloneConfig, type StandaloneEnv } from './config';
import { deletionDependencies, handleHealthz, runScheduled } from './jobs';
import { handleLimits } from './limits';
import { configurationPage, misconfiguredPage, originMovePage } from './pages';

export type { StandaloneEnv };

// The workspace's first limits. Provisional until measured on a clean account.
const initialLimits = {
	activeLinkLimit: 10_000,
	monthlyClickLimit: 50_000,
	retentionDays: 30,
	domainLimit: 5
};

const deadLetterQueue = 'flared-clicks-dlq';

const authForwarding = {
	methods: { ...sharedAuthMethods, ...ownerSignInMethods },
	sourceLimited: ownerSourceLimited
};

const standaloneDeletion: AccountDeletionEdition = {
	async confirmation(identity, userId) {
		const user = await identity
			.prepare('SELECT username FROM "user" WHERE id = ?')
			.bind(userId)
			.first<{ username: unknown }>();
		return typeof user?.username === 'string' && user.username ? user.username : null;
	},
	mismatchMessage: 'Type your username exactly to confirm.',
	suspendedMessage: 'This workspace is suspended, so it cannot be deleted now.'
};

function json(body: unknown, status: number): Response {
	return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

function notFound(): Response {
	return json(
		{ error: { code: 'NOT_FOUND', message: 'Route not found.', requestId: crypto.randomUUID() } },
		404
	);
}

// The request with only the given headers, plus the trusted client address. A header a browser
// sends as x-flared-source never survives.
function rebuilt(request: Request, names: string[], url = request.url): Request {
	const headers = new Headers();
	for (const name of names) {
		const value = request.headers.get(name);
		if (value !== null) headers.set(name, value);
	}
	const source = request.headers.get('cf-connecting-ip');
	if (source) headers.set('x-flared-source', source);
	return new Request(url, {
		method: request.method,
		headers,
		body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body
	});
}

// RFC 9727: where agents find the API, its OpenAPI description, and its documentation.
function apiCatalog(request: Request, origin: string): Response {
	if (request.method !== 'GET' && request.method !== 'HEAD')
		return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } });
	const api = `${origin}/v1`;
	const body = JSON.stringify({
		linkset: [
			{
				anchor: api,
				'service-desc': [{ href: `${api}/openapi.json`, type: 'application/vnd.oai.openapi+json' }]
			}
		]
	});
	return new Response(request.method === 'HEAD' ? null : body, {
		headers: {
			'content-type': 'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"',
			'cache-control': 'public, max-age=3600',
			'access-control-allow-origin': '*'
		}
	});
}

class Installation {
	readonly auth: AuthService;
	private readonly authRoutes;
	private readonly tokenAuth;
	readonly resource: string;

	constructor(
		readonly config: StandaloneConfig,
		readonly status: InstallationStatus
	) {
		this.authRoutes = createOwnerAuthRoutes({
			db: config.identity,
			config: {
				origin: config.origin,
				secret: config.secret,
				rateLimitSecret: config.rateLimitSecret
			},
			originMove: { routing: config.routing }
		});
		this.auth = { fetch: async (request) => this.authRoutes.fetch(request) };
		this.tokenAuth = createTokenAuth(config.identity, config.origin, config.secret);
		this.resource = `${config.origin}/mcp`;
	}

	// Only an active installation has a tenant to reach. Before setup and after deletion no
	// tenant matches, so no link opens, cached or not.
	get fixedTenantId(): string {
		return this.status.state === 'active' ? (this.status.fixedTenantId ?? '') : '';
	}

	api(authenticate: (request: Request) => Promise<ApiAuthentication>) {
		const { config } = this;
		return createApi({
			identity: config.identity,
			routing: config.routing,
			analytics: config.shards,
			appOrigin: config.origin,
			tokenAuth: this.tokenAuth,
			publicApiUrl: `${config.origin}/v1`,
			domains: { reservedHostnames: [config.host] },
			authenticate,
			fixedTenantId: this.fixedTenantId
		});
	}

	// session: the app's same-origin API, cookies only. bearer: tokens only, never cookies.
	apiRequest(request: Request, mode: 'session' | 'bearer', path: string): Promise<Response> {
		const url = new URL(request.url);
		url.pathname = path;
		const names =
			mode === 'session'
				? ['cookie', 'origin', 'content-type', 'accept', 'idempotency-key']
				: ['authorization', 'content-type', 'accept', 'idempotency-key'];
		const authenticate = apiAuthenticator(mode, {
			identity: this.config.identity,
			tokenAuth: this.tokenAuth,
			auth: this.auth,
			origin: this.config.origin
		});
		return Promise.resolve(this.api(authenticate).fetch(rebuilt(request, names, url.toString())));
	}

	redirects() {
		const { config } = this;
		return createRedirectHandler({
			routing: config.routing,
			appOrigin: config.origin,
			clicks: config.clicks,
			fixedTenantId: this.fixedTenantId
		});
	}

	oauthSite() {
		const { config } = this;
		return {
			origin: config.origin,
			secret: config.secret,
			rateLimitSecret: config.rateLimitSecret,
			resource: this.resource,
			identityRule: { kind: 'owner-username' as const, db: config.identity }
		};
	}
}

const setupPaths = new Set(['/setup', '/api/setup', '/healthz']);
// Assets SvelteKit needs for /setup and /app/login.
const isAsset = (path: string) =>
	path.startsWith('/_app/') || path === '/favicon.svg' || path === '/robots.txt';
// While the app host moves, the new host serves only what the move needs.
const movePaths = new Set(['/app/login', '/api/auth/sign-in/password', '/api/auth/session']);

async function appHost(
	request: Request,
	url: URL,
	env: StandaloneEnv,
	ctx: ExecutionContext,
	site: Installation
): Promise<Response> {
	const { config, status } = site;
	const path = url.pathname;
	if (path === '/healthz') return handleHealthz(request, config);
	if (status.state === 'misconfigured') return misconfiguredPage();
	// Short links on the app host; reserved paths never reach the redirect handler.
	if (!isReservedPath(path)) return site.redirects().fetch(request, ctx);
	if (path === '/.well-known/flared-domain-challenge') return notFound();

	if (path === '/api/setup')
		return handleSetup(rebuilt(request, ['origin', 'content-type']), {
			identity: config.identity,
			routing: config.routing,
			analytics: config.shards,
			analyticsShardId: config.analyticsShardId,
			config: {
				origin: config.origin,
				secret: config.secret,
				rateLimitSecret: config.rateLimitSecret
			},
			setupSecret: config.setupSecret,
			limits: initialLimits
		});

	if (status.state === 'unclaimed' || status.state === 'initializing') {
		if (setupPaths.has(path) || isAsset(path)) return page(request, env, ctx, site);
		if (path.startsWith('/api/') || path.startsWith('/v1/') || path === '/mcp')
			return json({ error: { code: 'SETUP_REQUIRED', message: 'Finish setup first.' } }, 503);
		return Response.redirect(new URL('/setup', config.origin).toString(), 303);
	}
	if (status.state === 'closed') {
		if (path.startsWith('/api/') || path.startsWith('/v1/') || path === '/mcp')
			return json(
				{ error: { code: 'INSTALLATION_CLOSED', message: 'This installation is closed.' } },
				410
			);
		return page(request, env, ctx, site);
	}

	if (status.appOrigin !== null && status.appOrigin !== config.origin) {
		if (path.startsWith('/api/auth/') && movePaths.has(path))
			return forwardAuthRoute(
				request,
				site.auth,
				request.headers.get('cf-connecting-ip'),
				authForwarding
			);
		if (movePaths.has(path) || isAsset(path)) return page(request, env, ctx, site);
		return originMovePage(status.appOrigin, config.origin);
	}

	if (path.startsWith('/api/auth/'))
		return forwardAuthRoute(
			request,
			site.auth,
			request.headers.get('cf-connecting-ip'),
			authForwarding
		);
	if (path.startsWith('/api/v1/'))
		return site.apiRequest(request, 'session', path.slice('/api'.length));
	if (path.startsWith('/v1/')) return site.apiRequest(request, 'bearer', path);
	if (path.startsWith('/api/account/'))
		return deleteAccount(rebuilt(request, ['cookie', 'origin', 'content-type', 'content-length']), {
			identity: config.identity,
			appOrigin: config.origin,
			authenticate: (incoming) => sessionPrincipal(incoming, site.auth, config.origin),
			edition: standaloneDeletion,
			start: (tenantId) =>
				ctx.waitUntil(
					runDeletions(deletionDependencies(config), { tenantId }).then(
						() => undefined,
						() => console.error(JSON.stringify({ event: 'deletion_start_failed' }))
					)
				)
		});
	if (path === '/api/settings/limits')
		return handleLimits(
			rebuilt(request, ['cookie', 'origin', 'content-type']),
			config,
			site.auth,
			site.fixedTenantId
		);
	if (path.startsWith('/api/')) return notFound();
	// The OAuth authorization server for connected apps such as AI assistants.
	if (isOAuthPath(path)) return handleOAuth(request, site.oauthSite(), config.identity);
	if (path === '/mcp')
		return handleMcp(
			rebuilt(request, [
				'authorization',
				'content-type',
				'accept',
				'origin',
				'mcp-protocol-version',
				'mcp-session-id',
				'last-event-id'
			]),
			site.oauthSite(),
			config.identity,
			(principal) => site.api(async () => principal)
		);
	if (
		path === '/.well-known/oauth-protected-resource' ||
		path === '/.well-known/oauth-protected-resource/mcp'
	)
		return protectedResourceDocument(request, site.resource, config.origin);
	if (path === '/.well-known/mcp/server-card.json')
		return serverCardDocument(request, site.resource);
	if (path === '/.well-known/ai-catalog.json')
		return aiCatalogDocument(request, {
			origin: config.origin,
			resource: site.resource,
			displayName: 'Flared'
		});
	if (path === '/.well-known/api-catalog') return apiCatalog(request, config.origin);
	return page(request, env, ctx, site);
}

// SvelteKit pages, with in-process services. Pages see the installation state.
function page(
	request: Request,
	env: StandaloneEnv,
	ctx: ExecutionContext,
	site: Installation
): Promise<Response> {
	const { config, status } = site;
	const api: AuthService = {
		fetch: (incoming) => {
			const url = new URL(incoming.url);
			return site.apiRequest(incoming, 'session', url.pathname);
		}
	};
	const oauth: AuthService = {
		fetch: async (incoming) => handleOAuth(incoming, site.oauthSite(), config.identity)
	};
	return sveltekit.fetch(
		request,
		{
			ASSETS: env.ASSETS,
			AUTH_SERVICE: site.auth,
			API_SERVICE: api,
			OAUTH_SERVICE: oauth,
			LIMITS_SERVICE: {
				fetch: (incoming: Request) => handleLimits(incoming, config, site.auth, site.fixedTenantId)
			},
			INSTALLATION: {
				state: status.state,
				moving: status.appOrigin !== null && status.appOrigin !== config.origin
			},
			SOURCE_URL: config.sourceUrl
		},
		ctx
	);
}

export default {
	async fetch(request, env, ctx) {
		const loaded = await readConfig(env);
		if (!loaded.ok) return configurationPage(loaded.problem, request);
		const { config } = loaded;
		const url = new URL(request.url);
		let status: InstallationStatus;
		try {
			status = await readInstallationStatus(config.identity);
		} catch {
			console.error(JSON.stringify({ event: 'installation_status_unavailable' }));
			return unavailable();
		}
		const site = new Installation(config, status);
		if (url.host === config.host) return appHost(request, url, env, ctx, site);
		// Every other host serves short links only: no auth route, cookie, or app page.
		return site.redirects().fetch(request, ctx);
	},

	async scheduled(controller, env) {
		const loaded = await readConfig(env);
		if (!loaded.ok) throw new Error(`Scheduled jobs need ${loaded.problem}`);
		await runScheduled(controller.cron, controller.scheduledTime, loaded.config);
	},

	// Click events from the redirect handler, and those that ran out of retries.
	async queue(batch, env) {
		const loaded = await readConfig(env);
		if (!loaded.ok) throw new Error(`The click consumer needs ${loaded.problem}`);
		const { config } = loaded;
		if (batch.queue === deadLetterQueue) {
			await createDeadLetterConsumer({ identity: config.identity })(batch);
			return;
		}
		const status = await readInstallationStatus(config.identity);
		await createClickConsumer({
			shards: config.shards,
			fixedTenantId: status.state === 'active' ? (status.fixedTenantId ?? '') : ''
		})(batch);
	}
} satisfies ExportedHandler<StandaloneEnv>;
