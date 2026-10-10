// SPDX-License-Identifier: AGPL-3.0-only
// Several workspaces per user: the membership migration, each session's active workspace, the
// stale-tab guard, workspace-bound tokens, and revocation of one workspace's credentials.
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { betterAuth } from 'better-auth';
import { scopePresets } from '../packages/contracts/src/tokens';
import { createDeletion, deleteIdentityRecords } from '../packages/data/src/deletions';
import { createIdentityAdapter } from '../packages/data/src/identity-adapter';
import {
	createTenant,
	deleteTenantCredentials,
	setActiveWorkspace,
	setTenantSuspension
} from '../packages/data/src/tenancy';
import { authenticateBearer, createApi } from '../packages/server/src/api';
import {
	createApiTokenPlugin,
	createToken,
	verifyToken
} from '../packages/server/src/auth/api-tokens';
import { createSessionOptions } from '../packages/server/src/auth/options';
import { withShownWorkspace } from '../packages/server/src/web/api';
import { projectPolicy, resolveTenant } from '../packages/server/src/tenancy';

const origin = 'https://app.example';
const identity = () => env.WORKSPACES_IDENTITY;
const limits = { activeLinkLimit: 100, monthlyClickLimit: 5000, retentionDays: 30, domainLimit: 1 };

function auth() {
	return betterAuth({
		...createSessionOptions(origin),
		secret: 'test-only-auth-secret-at-least-thirty-two-characters',
		database: createIdentityAdapter(identity()),
		rateLimit: { enabled: false },
		logger: { disabled: true },
		plugins: [createApiTokenPlugin()]
	});
}

async function addUser(userId: string) {
	await identity()
		.prepare(
			'INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 0, 0)'
		)
		.bind(userId, '', `${userId}@example.com`)
		.run();
}

async function addWorkspace(tenantId: string, name: string, ownerUserId: string, now: number) {
	await createTenant(identity(), {
		id: tenantId,
		name,
		ownerUserId,
		analyticsShardId: 'analytics-1',
		limits,
		now
	});
	await projectPolicy(
		identity(),
		{ routing: env.WORKSPACES_ROUTING, analytics: { 'analytics-1': env.WORKSPACES_ANALYTICS } },
		tenantId,
		now
	);
}

async function addSession(sessionId: string, userId: string) {
	await identity()
		.prepare(
			'INSERT INTO "session" (id, expiresAt, token, createdAt, updatedAt, userId) VALUES (?, ?, ?, 0, 0, ?)'
		)
		.bind(sessionId, Date.now() + 86_400_000, `token-${sessionId}`, userId)
		.run();
}

async function count(table: string, ...values: string[]): Promise<number> {
	const row = await identity()
		.prepare(`SELECT COUNT(*) AS n FROM ${table}`)
		.bind(...values)
		.first<{ n: number }>();
	return row?.n ?? -1;
}

// The test session in x-test-session, or the bearer token.
function api() {
	const tokenAuth = auth();
	return createApi({
		identity: identity(),
		routing: env.WORKSPACES_ROUTING,
		analytics: { 'analytics-1': env.WORKSPACES_ANALYTICS },
		appOrigin: origin,
		tokenAuth,
		authenticate: async (request) => {
			if (request.headers.has('authorization'))
				return authenticateBearer(tokenAuth, identity(), request);
			const sessionId = request.headers.get('x-test-session');
			if (!sessionId) return null;
			const row = await identity()
				.prepare('SELECT "userId" FROM "session" WHERE id = ?')
				.bind(sessionId)
				.first<{ userId: string }>();
			if (!row) return null;
			return {
				kind: 'session',
				userId: row.userId,
				sessionId,
				signedInAt: new Date().toISOString()
			};
		}
	});
}

function call(method: string, path: string, headers: Record<string, string>, body?: unknown) {
	const init: RequestInit = { method, headers: { ...headers } };
	if (body !== undefined) {
		init.body = JSON.stringify(body);
		(init.headers as Record<string, string>)['content-type'] = 'application/json';
	}
	return api().fetch(new Request(`${origin}/v1${path}`, init));
}

const session = (sessionId: string, extra: Record<string, string> = {}) => ({
	'x-test-session': sessionId,
	origin,
	...extra
});
const bearer = (secret: string) => ({ authorization: `Bearer ${secret}` });
const choose = (sessionId: string, tenantId: string) =>
	call('POST', '/workspaces/active', session(sessionId), { tenantId });

async function code(response: Response): Promise<string> {
	return ((await response.json()) as { error: { code: string } }).error.code;
}

async function workspaceName(sessionId: string): Promise<string> {
	const response = await call('GET', '/workspace', session(sessionId));
	return ((await response.json()) as { workspace: { name: string } }).workspace.name;
}

async function linkCount(headers: Record<string, string>): Promise<number> {
	const response = await call('GET', '/links', headers);
	expect(response.status).toBe(200);
	return ((await response.json()) as { links: unknown[] }).links.length;
}

beforeAll(async () => {
	await applyD1Migrations(identity(), env.IDENTITY_MIGRATIONS, 'flared_core_migrations');
	await identity()
		.prepare("INSERT INTO installation (id, mode, created_at) VALUES (1, 'multi', 0)")
		.run();
	await applyD1Migrations(env.WORKSPACES_ROUTING, env.ROUTING_MIGRATIONS, 'flared_core_migrations');
	await applyD1Migrations(
		env.WORKSPACES_ANALYTICS,
		env.ANALYTICS_MIGRATIONS,
		'flared_core_migrations'
	);
	await env.WORKSPACES_ROUTING.batch([
		env.WORKSPACES_ROUTING.prepare(
			"INSERT INTO domain_namespaces (id, hostname, created_at) VALUES ('dom-short', 'short.example', 0)"
		),
		env.WORKSPACES_ROUTING.prepare(
			"INSERT INTO domains (id, tenant_id, state, is_default, created_at, updated_at) VALUES ('dom-short', NULL, 'active', 1, 0, 0)"
		)
	]);
	for (const userId of ['ana', 'bo', 'cy', 'di', 'eve']) await addUser(userId);
	// ana owns two workspaces; the oldest comes first.
	await addWorkspace('ws-a', 'Alpha', 'ana', 1);
	await addWorkspace('ws-b', 'Beta', 'ana', 2);
	await addWorkspace('ws-c', 'Bo', 'bo', 3);
	await addWorkspace('ws-d', 'Cy one', 'cy', 4);
	await addWorkspace('ws-e', 'Cy two', 'cy', 5);
	await addWorkspace('ws-f', 'Di one', 'di', 6);
	await addWorkspace('ws-g', 'Di two', 'di', 7);
	for (const [sessionId, userId] of [
		['sess-1', 'ana'],
		['sess-2', 'ana'],
		['sess-bo', 'bo'],
		['sess-cy', 'cy'],
		['sess-di', 'di']
	])
		await addSession(sessionId, userId);
});

describe('membership migration', () => {
	it('keeps every membership, adds the member role, and keeps one owner', async () => {
		const db = env.MIGRATION_IDENTITY;
		const migrations = env.IDENTITY_MIGRATIONS;
		const index = migrations.findIndex((item) => item.name.startsWith('0012_'));
		expect(index).toBeGreaterThan(0);
		await applyD1Migrations(db, migrations.slice(0, index), 'flared_core_migrations');
		await db.batch([
			db.prepare("INSERT INTO installation (id, mode, created_at) VALUES (1, 'multi', 0)"),
			db.prepare(
				"INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('old', '', 'old@example.com', 1, 0, 0), ('new', '', 'new@example.com', 1, 0, 0)"
			),
			db.prepare(
				"INSERT INTO tenants (id, name, analytics_shard_id, created_at, activated_at) VALUES ('t-old', 'Old', 'analytics-1', 1, 2), ('t-two', 'Two', 'analytics-1', 3, 4)"
			),
			db.prepare(
				"INSERT INTO tenant_memberships (tenant_id, user_id, role, created_at) VALUES ('t-old', 'old', 'owner', 1)"
			)
		]);
		const add = (tenantId: string, userId: string, role: string) =>
			db
				.prepare(
					'INSERT INTO tenant_memberships (tenant_id, user_id, role, created_at) VALUES (?, ?, ?, 9)'
				)
				.bind(tenantId, userId, role)
				.run();
		await expect(add('t-old', 'new', 'member')).rejects.toThrow();
		await expect(add('t-two', 'old', 'owner')).rejects.toThrow();

		await applyD1Migrations(db, migrations, 'flared_core_migrations');
		expect(
			await db.prepare('SELECT tenant_id, user_id, role, created_at FROM tenant_memberships').all()
		).toMatchObject({
			results: [{ tenant_id: 't-old', user_id: 'old', role: 'owner', created_at: 1 }]
		});
		await add('t-old', 'new', 'member');
		await add('t-two', 'old', 'owner');
		await expect(add('t-two', 'new', 'owner')).rejects.toThrow();
		await expect(add('t-two', 'new', 'admin')).rejects.toThrow();
		const { results } = await db
			.prepare("SELECT tenant_id FROM tenant_memberships WHERE user_id = 'old' ORDER BY tenant_id")
			.all<{ tenant_id: string }>();
		expect(results.map((row) => row.tenant_id)).toEqual(['t-old', 't-two']);
	});
});

describe('active workspace', () => {
	it('uses the session choice, then the last choice, then the oldest workspace', async () => {
		const as = (sessionId: string) => resolveTenant(identity(), { userId: 'ana', sessionId });
		expect(await as('sess-1')).toEqual({
			status: 'active',
			tenantId: 'ws-a',
			role: 'owner',
			suspension: null
		});
		const choice = { userId: 'ana', now: 10 };
		expect(
			await setActiveWorkspace(identity(), { ...choice, sessionId: 'sess-1', tenantId: 'ws-b' })
		).toBe(true);
		expect(await as('sess-1')).toMatchObject({ tenantId: 'ws-b' });
		// A session that never chose opens the user's last choice.
		expect(await as('sess-2')).toMatchObject({ tenantId: 'ws-b' });
		expect(
			await setActiveWorkspace(identity(), { ...choice, sessionId: 'sess-2', tenantId: 'ws-a' })
		).toBe(true);
		expect(await as('sess-2')).toMatchObject({ tenantId: 'ws-a' });
		expect(await as('sess-1')).toMatchObject({ tenantId: 'ws-b' });
		expect(await as('sess-new')).toMatchObject({ tenantId: 'ws-a' });
	});

	it('refuses another user’s workspace and another user’s session', async () => {
		const refused = [
			{ userId: 'ana', sessionId: 'sess-1', tenantId: 'ws-c' },
			{ userId: 'bo', sessionId: 'sess-bo', tenantId: 'ws-a' },
			{ userId: 'ana', sessionId: 'sess-bo', tenantId: 'ws-a' },
			{ userId: 'ana', sessionId: 'sess-missing', tenantId: 'ws-a' }
		];
		for (const choice of refused)
			expect(await setActiveWorkspace(identity(), { ...choice, now: 11 }), choice.tenantId).toBe(
				false
			);
		expect(await count('session_workspaces WHERE session_id = ?', 'sess-bo')).toBe(0);
		expect(await resolveTenant(identity(), { userId: 'bo', sessionId: 'sess-bo' })).toMatchObject({
			tenantId: 'ws-c'
		});
		expect(await resolveTenant(identity(), { userId: 'ana', sessionId: 'sess-1' })).toMatchObject({
			tenantId: 'ws-b'
		});
	});

	it('falls through a pointer to a workspace the user lost', async () => {
		expect(
			await setActiveWorkspace(identity(), {
				userId: 'cy',
				sessionId: 'sess-cy',
				tenantId: 'ws-e',
				now: 12
			})
		).toBe(true);
		// Simulates the removal of a membership, which Delivery C adds.
		await identity()
			.prepare("DELETE FROM tenant_memberships WHERE tenant_id = 'ws-e' AND user_id = 'cy'")
			.run();
		expect(await resolveTenant(identity(), { userId: 'cy', sessionId: 'sess-cy' })).toMatchObject({
			status: 'active',
			tenantId: 'ws-d'
		});
		expect(
			await setActiveWorkspace(identity(), {
				userId: 'cy',
				sessionId: 'sess-cy',
				tenantId: 'ws-e',
				now: 13
			})
		).toBe(false);
	});

	it('drops the pointer with its session', async () => {
		expect(await count('session_workspaces WHERE session_id = ?', 'sess-cy')).toBe(1);
		const context = await auth().$context;
		await context.internalAdapter.deleteSession('token-sess-cy');
		expect(await count('"session" WHERE id = ?', 'sess-cy')).toBe(0);
		expect(await count('session_workspaces WHERE session_id = ?', 'sess-cy')).toBe(0);
	});
});

describe('workspace API', () => {
	it('switches the workspace from the dashboard only, for a member', async () => {
		expect((await choose('sess-1', 'ws-a')).status).toBe(204);
		expect(await workspaceName('sess-1')).toBe('Alpha');
		expect((await choose('sess-1', 'ws-b')).status).toBe(204);
		expect(await workspaceName('sess-1')).toBe('Beta');

		const other = await choose('sess-1', 'ws-c');
		expect([other.status, await code(other)]).toEqual([404, 'NOT_FOUND']);
		const invalid = await call('POST', '/workspaces/active', session('sess-1'), { id: 'ws-a' });
		expect([invalid.status, await code(invalid)]).toEqual([422, 'INVALID_INPUT']);
		const crossSite = await call(
			'POST',
			'/workspaces/active',
			{ 'x-test-session': 'sess-1' },
			{
				tenantId: 'ws-a'
			}
		);
		expect([crossSite.status, await code(crossSite)]).toEqual([403, 'ORIGIN_REJECTED']);
		const read = await call('GET', '/workspaces/active', session('sess-1'));
		expect([read.status, await code(read)]).toEqual([405, 'METHOD_NOT_ALLOWED']);
		expect(await workspaceName('sess-1')).toBe('Beta');
	});

	it('lists the person’s workspaces and names the active one with its role', async () => {
		expect((await choose('sess-1', 'ws-b')).status).toBe(204);
		const listed = await call('GET', '/workspaces', session('sess-1'));
		expect(listed.status).toBe(200);
		expect(await listed.json()).toEqual({
			workspaces: [
				{ id: 'ws-a', name: 'Alpha', role: 'owner', status: 'active' },
				{ id: 'ws-b', name: 'Beta', role: 'owner', status: 'active' }
			],
			activeId: 'ws-b'
		});
		const active = await call('GET', '/workspace', session('sess-1'));
		expect(await active.json()).toEqual({
			workspace: { id: 'ws-b', name: 'Beta', role: 'owner' }
		});
		// The list stays readable while the active workspace is suspended, so the person can leave.
		await setTenantSuspension(identity(), 'ws-b', { reason: 'spam' }, 25);
		const suspended = (await (await call('GET', '/workspaces', session('sess-1'))).json()) as {
			workspaces: { id: string; status: string }[];
		};
		expect(suspended.workspaces.find((item) => item.id === 'ws-b')?.status).toBe('suspended');
		await setTenantSuspension(identity(), 'ws-b', null, 26);
		const other = (await (await call('GET', '/workspaces', session('sess-bo'))).json()) as {
			workspaces: { id: string }[];
		};
		expect(other.workspaces.map((item) => item.id)).toEqual(['ws-c']);
	});

	it('forwards the workspace a form showed to the API', () => {
		const form = new FormData();
		const headers = new Headers({ cookie: 'session=1' });
		expect(withShownWorkspace(headers, form)).toBe(headers);
		form.set('workspace', 'ws-a');
		const named = withShownWorkspace(headers, form);
		expect(named.get('x-flared-workspace')).toBe('ws-a');
		expect(named.get('cookie')).toBe('session=1');
		expect(headers.has('x-flared-workspace')).toBe(false);
	});

	it('refuses a change from a tab that shows another workspace', async () => {
		const rename = (headers: Record<string, string>, name: string) =>
			call('PATCH', '/workspace', session('sess-1', headers), { name });
		const stale = await rename({ 'x-flared-workspace': 'ws-a' }, 'Wrong');
		expect([stale.status, await code(stale)]).toEqual([409, 'WORKSPACE_CHANGED']);
		expect(await workspaceName('sess-1')).toBe('Beta');
		expect(await workspaceName('sess-2')).toBe('Alpha');

		expect((await rename({ 'x-flared-workspace': 'ws-b' }, 'Beta two')).status).toBe(200);
		expect(await workspaceName('sess-1')).toBe('Beta two');
		// A page without the header, from before the guard, still works.
		expect((await rename({}, 'Beta')).status).toBe(200);
		// Reads carry no risk and pass with any header.
		const read = await call(
			'GET',
			'/workspace',
			session('sess-1', { 'x-flared-workspace': 'ws-a' })
		);
		expect(read.status).toBe(200);
	});

	it('keeps a token in the workspace it was made in', async () => {
		expect((await choose('sess-1', 'ws-a')).status).toBe(204);
		const issued = await call('POST', '/tokens', session('sess-1'), {
			name: 'Alpha CI',
			scopes: scopePresets.full,
			expiresInDays: 30
		});
		expect(issued.status).toBe(201);
		const { secret } = (await issued.json()) as { secret: string };
		expect((await choose('sess-1', 'ws-b')).status).toBe(204);

		const created = await call(
			'POST',
			'/links',
			{ ...bearer(secret), 'idempotency-key': 'alpha-1' },
			{ destination: 'https://example.com/alpha' }
		);
		expect(created.status).toBe(201);
		expect(await linkCount(bearer(secret))).toBe(1);
		expect(await linkCount(session('sess-2'))).toBe(1);
		expect(await linkCount(session('sess-1'))).toBe(0);

		// The token page lists the tokens of the workspace on screen.
		const tokens = async (sessionId: string) =>
			((await (await call('GET', '/tokens', session(sessionId))).json()) as { tokens: unknown[] })
				.tokens.length;
		expect(await tokens('sess-1')).toBe(0);
		expect(await tokens('sess-2')).toBe(1);
	});

	it('ends a member’s token when the member leaves the workspace', async () => {
		await identity()
			.prepare(
				"INSERT INTO tenant_memberships (tenant_id, user_id, role, created_at) VALUES ('ws-a', 'eve', 'member', 20)"
			)
			.run();
		const { secret } = await createToken(auth(), {
			userId: 'eve',
			tenantId: 'ws-a',
			input: { name: 'Eve', scopes: scopePresets.read, expiresInDays: 30 }
		});
		expect(await verifyToken(auth(), identity(), secret)).toMatchObject({
			status: 'valid',
			principal: { userId: 'eve', tenantId: 'ws-a' }
		});
		expect(await linkCount(bearer(secret))).toBe(1);
		await identity()
			.prepare("DELETE FROM tenant_memberships WHERE tenant_id = 'ws-a' AND user_id = 'eve'")
			.run();
		expect(await verifyToken(auth(), identity(), secret)).toEqual({ status: 'invalid' });
		const refused = await call('GET', '/links', bearer(secret));
		expect([refused.status, await code(refused)]).toEqual([401, 'UNAUTHENTICATED']);
	});

	it('keeps the other workspace usable while one is suspended', async () => {
		await setTenantSuspension(identity(), 'ws-b', { reason: 'phishing' }, 30);
		const blocked = await call('PATCH', '/workspace', session('sess-1'), { name: 'Beta' });
		expect([blocked.status, await code(blocked)]).toEqual([403, 'WORKSPACE_SUSPENDED']);
		expect((await choose('sess-1', 'ws-a')).status).toBe(204);
		expect((await call('PATCH', '/workspace', session('sess-1'), { name: 'Alpha' })).status).toBe(
			200
		);
		// A suspended workspace can still be opened to read and export.
		expect((await choose('sess-1', 'ws-b')).status).toBe(204);
		expect((await call('GET', '/workspace', session('sess-1'))).status).toBe(200);
		await setTenantSuspension(identity(), 'ws-b', null, 31);
	});
});

describe('one workspace’s credentials', () => {
	async function tokenFor(userId: string, tenantId: string) {
		return (
			await createToken(auth(), {
				userId,
				tenantId,
				input: { name: tenantId, scopes: scopePresets.read, expiresInDays: 30 }
			})
		).secret;
	}
	const valid = async (secret: string) =>
		(await verifyToken(auth(), identity(), secret)).status === 'valid';

	it('deletes one of several workspaces and keeps the user, sessions, and other tokens', async () => {
		const kept = await tokenFor('di', 'ws-f');
		const gone = await tokenFor('di', 'ws-g');
		expect(
			await setActiveWorkspace(identity(), {
				userId: 'di',
				sessionId: 'sess-di',
				tenantId: 'ws-g',
				now: 40
			})
		).toBe(true);
		expect(
			await createDeletion(identity(), {
				tenantId: 'ws-g',
				userId: 'di',
				analyticsShardId: 'analytics-1',
				contactEmail: null,
				now: 41
			})
		).toBe(true);
		expect(await valid(gone)).toBe(false);
		expect(await valid(kept)).toBe(true);
		expect(await count('"session" WHERE "userId" = ?', 'di')).toBe(1);
		// The session moves on to the workspace that stays; the deleted one cannot be chosen.
		expect(await resolveTenant(identity(), { userId: 'di', sessionId: 'sess-di' })).toMatchObject({
			status: 'active',
			tenantId: 'ws-f'
		});
		expect(
			await setActiveWorkspace(identity(), {
				userId: 'di',
				sessionId: 'sess-di',
				tenantId: 'ws-g',
				now: 42
			})
		).toBe(false);

		await deleteIdentityRecords(identity(), 'ws-g', 'di', 43);
		expect(await count('tenants WHERE id = ?', 'ws-g')).toBe(0);
		expect(await count('session_workspaces WHERE tenant_id = ?', 'ws-g')).toBe(0);
		expect(await count('user_workspace_preferences WHERE tenant_id = ?', 'ws-g')).toBe(0);
		expect(await count('user WHERE id = ?', 'di')).toBe(1);
	});

	it('signs the members out and ends only the tokens of the revoked workspace', async () => {
		const alpha = await tokenFor('ana', 'ws-a');
		const beta = await tokenFor('ana', 'ws-b');
		const bo = await tokenFor('bo', 'ws-c');
		await deleteTenantCredentials(identity(), 'ws-b');
		expect(await valid(beta)).toBe(false);
		expect(await valid(alpha)).toBe(true);
		expect(await valid(bo)).toBe(true);
		expect(await count('"session" WHERE "userId" = ?', 'ana')).toBe(0);
		expect(await count('"session" WHERE "userId" = ?', 'bo')).toBe(1);
	});
});
