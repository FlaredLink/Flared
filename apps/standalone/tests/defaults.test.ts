// SPDX-License-Identifier: AGPL-3.0-only
// A deployment that sets only SETUP_SECRET, against its own real D1: setup runs at the address
// it was opened on, which becomes the app origin; the Worker makes and keeps its own auth
// secret; and a short setup secret keeps setup closed.
import { env } from 'cloudflare:workers';
import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { installationAuthSecret } from '@flared/data/setup';
import worker, { type StandaloneEnv } from '../worker/index';

const origin = 'https://flared-2.example.workers.dev';
const setupSecret = 'sixteen-chars-ok';

function deployment(change: Partial<StandaloneEnv> = {}): StandaloneEnv {
	return {
		ASSETS: { fetch: async () => new Response('asset') },
		IDENTITY: env.DEFAULTS_IDENTITY,
		ROUTING: env.DEFAULTS_ROUTING,
		ANALYTICS_1: env.DEFAULTS_ANALYTICS,
		SETUP_SECRET: setupSecret,
		...change
	};
}

async function call(
	url: string,
	init: RequestInit<IncomingRequestCfProperties> = {},
	change: Partial<StandaloneEnv> = {}
): Promise<Response> {
	const ctx = createExecutionContext();
	const request = new Request<unknown, IncomingRequestCfProperties>(url, init);
	const response = await worker.fetch(request, deployment(change), ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

const setup = (at: string, change: Partial<StandaloneEnv> = {}) =>
	call(
		`${at}/api/setup`,
		{
			method: 'POST',
			headers: {
				origin: at,
				'content-type': 'application/json',
				'cf-connecting-ip': '198.51.100.9'
			},
			body: JSON.stringify({
				secret: setupSecret,
				username: 'owner',
				password: 'correct horse battery',
				workspaceName: 'Links'
			})
		},
		change
	);

async function code(response: Response): Promise<string | undefined> {
	return ((await response.clone().json()) as { error?: { code?: string } }).error?.code;
}

async function storedSecret(): Promise<string | null> {
	const row = await env.DEFAULTS_IDENTITY.prepare(
		'SELECT auth_secret FROM installation_key WHERE id = 1'
	).first<{ auth_secret: string }>();
	return row?.auth_secret ?? null;
}

let owner = '';

beforeAll(async () => {
	await applyD1Migrations(env.DEFAULTS_IDENTITY, env.IDENTITY_MIGRATIONS);
	await applyD1Migrations(env.DEFAULTS_ROUTING, env.ROUTING_MIGRATIONS);
	await applyD1Migrations(env.DEFAULTS_ANALYTICS, env.ANALYTICS_MIGRATIONS);
});

describe('a deployment with only SETUP_SECRET', () => {
	it('makes one auth secret, even for parallel first requests, and keeps it', async () => {
		const [first, second] = await Promise.all([
			installationAuthSecret(env.DEFAULTS_IDENTITY, 1),
			installationAuthSecret(env.DEFAULTS_IDENTITY, 2)
		]);
		expect(first).toBe(second);
		expect(first.length).toBeGreaterThanOrEqual(32);
		expect(await storedSecret()).toBe(first);
		expect(await installationAuthSecret(env.DEFAULTS_IDENTITY, 3)).toBe(first);
	});

	it('serves setup on the address it is opened on, and sends http: to https:', async () => {
		const home = await call(`${origin}/`);
		expect(home.status).toBe(303);
		expect(home.headers.get('location')).toBe(`${origin}/setup`);
		const plain = await call('http://flared-2.example.workers.dev/setup?step=1');
		expect(plain.status).toBe(308);
		expect(plain.headers.get('location')).toBe(`${origin}/setup?step=1`);
	});

	it('keeps setup closed with a setup secret shorter than 16 characters', async () => {
		const short = await setup(origin, { SETUP_SECRET: 'fifteen-chars-x' });
		expect(await code(short)).toBe('SETUP_UNAVAILABLE');
	});

	it('stores the setup address as the app origin, and other hosts serve only short links', async () => {
		const created = await setup(origin);
		expect(created.status).toBe(200);
		owner = created.headers
			.getSetCookie()
			.map((cookie) => cookie.split(';')[0])
			.filter((pair) => pair.includes('session_token='))
			.join('; ');
		expect(owner).toContain('session_token=');
		const row = await env.DEFAULTS_IDENTITY.prepare(
			'SELECT app_origin FROM installation_setup WHERE id = 1'
		).first<{ app_origin: string }>();
		expect(row?.app_origin).toBe(origin);
		for (const path of ['/setup', '/app', '/api/auth/session']) {
			const other = await call(`https://flared-3.example.workers.dev${path}`, {
				headers: { cookie: owner }
			});
			expect(other.status, path).toBe(404);
		}
	});

	it('signs sessions with the stored secret', async () => {
		const name = async (change: Partial<StandaloneEnv>) => {
			const response = await call(
				`${origin}/api/auth/session`,
				{ headers: { cookie: owner } },
				change
			);
			return ((await response.json()) as { user?: { name: string } } | null)?.user?.name;
		};
		expect(await name({})).toBe('owner');
		const stored = await storedSecret();
		expect(stored).not.toBeNull();
		expect(await name({ AUTH_SECRET: stored ?? '' })).toBe('owner');
		expect(
			await name({ AUTH_SECRET: 'another-auth-secret-of-at-least-32-characters' })
		).toBeUndefined();
	});
});
