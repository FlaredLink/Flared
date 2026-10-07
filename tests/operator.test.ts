// SPDX-License-Identifier: AGPL-3.0-only
// Operator abuse actions against real D1: a block reaches redirects within the snapshot bound
// and never changes the owner's status, a suspension stops one tenant's links through the
// policy projection, a suspended workspace can still read and export, and a revocation ends the
// credentials of one tenant only.
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createDeletion } from '../packages/data/src/deletions';
import { createTenant } from '../packages/data/src/tenancy';
import { createApi, type ApiPrincipal } from '../packages/server/src/api';
import { requestDeletion } from '../packages/server/src/deletion';
import {
	blockLink,
	reinstateTenant,
	revokeCustomerAccess,
	suspendTenant,
	unblockLink
} from '../packages/server/src/operator';
import { createRedirectHandler, snapshotLifetimeMs } from '../packages/server/src/redirect';
import { projectPolicy, retryProjections, updatePolicy } from '../packages/server/src/tenancy';

const identity = () => env.OPERATOR_IDENTITY;
const routing = () => env.OPERATOR_ROUTING;
const stores = () => ({ routing: routing(), analytics: { 'analytics-1': env.OPERATOR_ANALYTICS } });
const operator = { kind: 'operator', id: 'admin-session-1' } as const;
const origin = 'https://app.example';
const start = Date.UTC(2026, 9, 21, 12);
const limits = { activeLinkLimit: 100, monthlyClickLimit: 5000, retentionDays: 30, domainLimit: 1 };

let cacheCounter = 0;
function redirects(now: () => number) {
	cacheCounter += 1;
	return createRedirectHandler({
		routing: routing(),
		appOrigin: origin,
		reportUrl: 'https://app.example/report',
		cacheName: `operator-test-${cacheCounter}`,
		now
	});
}

function open(app: ReturnType<typeof redirects>, slug: string) {
	return app.fetch(
		new Request(`https://short.example/${slug}`, {
			redirect: 'manual',
			headers: { accept: 'text/html' }
		})
	);
}

// x-test-token makes the request a token call with every scope.
function api() {
	return createApi({
		identity: identity(),
		routing: routing(),
		analytics: stores().analytics,
		appOrigin: origin,
		authenticate: async (request): Promise<ApiPrincipal> => {
			const userId = request.headers.get('x-test-user') ?? '';
			const tenantId = request.headers.get('x-test-token');
			return tenantId
				? {
						kind: 'token',
						userId,
						tenantId,
						scopes: ['links:read', 'links:write', 'analytics:read'],
						token: { id: 'token-1', name: '', start: 'fl_', expiresAt: null }
					}
				: { kind: 'session', userId, signedInAt: new Date(start).toISOString() };
		}
	});
}

async function call(
	user: string,
	path: string,
	init: RequestInit & { token?: string } = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
	const headers = new Headers(init.headers);
	headers.set('x-test-user', user);
	headers.set('origin', origin);
	if (init.token) headers.set('x-test-token', init.token);
	if (init.body) headers.set('content-type', 'application/json');
	const response = await api().fetch(new Request(`${origin}/v1${path}`, { ...init, headers }));
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : {} };
}

const errorCode = (result: { body: Record<string, unknown> }) =>
	(result.body.error as { code?: string } | undefined)?.code;

async function addWorkspace(name: string): Promise<{ tenantId: string; userId: string }> {
	const tenantId = `t-${name}`;
	const userId = `user-${name}`;
	await identity()
		.prepare(
			'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 0, 0)'
		)
		.bind(userId, '', `${name}@example.com`)
		.run();
	await createTenant(identity(), {
		id: tenantId,
		name: 'Workspace',
		ownerUserId: userId,
		analyticsShardId: 'analytics-1',
		limits,
		now: 1
	});
	await projectPolicy(identity(), stores(), tenantId, 1);
	return { tenantId, userId };
}

let linkCounter = 0;
async function addLink(tenantId: string, slug: string): Promise<string> {
	linkCounter += 1;
	const id = `link-${linkCounter}`;
	await routing().batch([
		routing()
			.prepare("INSERT INTO slug_reservations (domain_id, slug) VALUES ('dom-short', ?)")
			.bind(slug),
		routing()
			.prepare(
				"INSERT INTO links (id, tenant_id, domain_id, slug, destination, title, status, created_at, updated_at) VALUES (?, ?, 'dom-short', ?, 'https://example.com/a', NULL, 'active', 0, 0)"
			)
			.bind(id, tenantId, slug)
	]);
	return id;
}

async function count(db: D1Database, sql: string, ...values: unknown[]): Promise<number> {
	const row = await db
		.prepare(`SELECT COUNT(*) AS n FROM ${sql}`)
		.bind(...values)
		.first<{ n: number }>();
	return row?.n ?? -1;
}

beforeAll(async () => {
	await applyD1Migrations(identity(), env.IDENTITY_MIGRATIONS, 'flared_core_migrations');
	await applyD1Migrations(routing(), env.ROUTING_MIGRATIONS, 'flared_core_migrations');
	await applyD1Migrations(
		env.OPERATOR_ANALYTICS,
		env.ANALYTICS_MIGRATIONS,
		'flared_core_migrations'
	);
	await identity()
		.prepare("INSERT INTO installation (id, mode, created_at) VALUES (1, 'multi', 0)")
		.run();
	await routing().batch([
		routing().prepare(
			"INSERT INTO domain_namespaces (id, hostname, created_at) VALUES ('dom-short', 'short.example', 0)"
		),
		routing().prepare(
			"INSERT INTO domains (id, tenant_id, state, is_default, created_at, updated_at) VALUES ('dom-short', NULL, 'active', 1, 0, 0)"
		)
	]);
});

describe('link blocks', () => {
	it('stop a redirect within the snapshot bound and open again at once when cleared', async () => {
		const { tenantId } = await addWorkspace('bound');
		const linkId = await addLink(tenantId, 'bound-link');
		let now = start;
		const app = redirects(() => now);
		expect((await open(app, 'bound-link')).status).toBe(302);

		now = start + 1000;
		expect(await blockLink(routing(), operator, { linkId, reason: 'phishing', now })).toEqual({
			status: 'changed',
			tenantId
		});
		// The snapshot from the first visit may still serve until its deadline.
		now = start + snapshotLifetimeMs - 1;
		expect((await open(app, 'bound-link')).status).toBe(302);
		now = start + snapshotLifetimeMs;
		const blocked = await open(app, 'bound-link');
		expect(blocked.status).toBe(410);
		expect(blocked.headers.get('cache-control')).toBe('no-store');
		const page = await blocked.text();
		expect(page).toContain('This link was blocked');
		expect(page).toContain('href="https://app.example/report"');
		expect(page).not.toContain('example.com/a');

		expect(await unblockLink(routing(), operator, { linkId })).toEqual({
			status: 'changed',
			tenantId
		});
		expect((await open(app, 'bound-link')).status).toBe(302);
	});

	it('change nothing when repeated, and report a missing link', async () => {
		const { tenantId } = await addWorkspace('repeat');
		const linkId = await addLink(tenantId, 'repeat-link');
		await blockLink(routing(), operator, { linkId, reason: 'spam', now: start });
		expect(
			await blockLink(routing(), operator, { linkId, reason: 'malware', now: start + 5 })
		).toEqual({ status: 'unchanged', tenantId });
		const stored = await routing()
			.prepare('SELECT blocked_at, blocked_reason FROM links WHERE id = ?')
			.bind(linkId)
			.first();
		expect(stored).toEqual({ blocked_at: start, blocked_reason: 'spam' });
		expect(
			await blockLink(routing(), operator, { linkId: 'no-link', reason: 'spam', now: start })
		).toEqual({ status: 'not_found' });
		await unblockLink(routing(), operator, { linkId });
		expect(await unblockLink(routing(), operator, { linkId })).toEqual({
			status: 'unchanged',
			tenantId
		});
	});

	it('let the owner only turn a blocked link off, and never turn it on when cleared', async () => {
		const { tenantId, userId } = await addWorkspace('owner');
		const linkId = await addLink(tenantId, 'owner-link');
		await blockLink(routing(), operator, { linkId, reason: 'phishing', now: start });

		const read = await call(userId, `/links/${linkId}`);
		expect((read.body.link as { blocked: unknown }).blocked).toEqual({ reason: 'phishing' });
		const edit = await call(userId, `/links/${linkId}`, {
			method: 'PATCH',
			body: JSON.stringify({ destination: 'https://example.com/b' })
		});
		expect(edit.status).toBe(409);
		expect(errorCode(edit)).toBe('LINK_BLOCKED');

		const off = await call(userId, `/links/${linkId}`, {
			method: 'PATCH',
			body: JSON.stringify({ enabled: false })
		});
		expect(off.status).toBe(200);
		const on = await call(userId, `/links/${linkId}`, {
			method: 'PATCH',
			body: JSON.stringify({ enabled: true })
		});
		expect(errorCode(on)).toBe('LINK_BLOCKED');

		await unblockLink(routing(), operator, { linkId });
		const after = await call(userId, `/links/${linkId}`);
		expect(after.body.link).toMatchObject({ enabled: false, blocked: null });
		expect(
			(
				await open(
					redirects(() => start),
					'owner-link'
				)
			).status
		).toBe(404);
	});
});

describe('tenant suspension', () => {
	it('stops every link of one tenant only, survives a plan change, and keeps link blocks', async () => {
		const target = await addWorkspace('abuser');
		const other = await addWorkspace('bystander');
		const first = await addLink(target.tenantId, 'abuser-1');
		await addLink(target.tenantId, 'abuser-2');
		await addLink(other.tenantId, 'bystander-1');
		await blockLink(routing(), operator, { linkId: first, reason: 'phishing', now: start });

		expect(
			await suspendTenant(identity(), stores(), operator, {
				tenantId: target.tenantId,
				reason: 'phishing',
				now: start
			})
		).toEqual({ status: 'changed', tenantId: target.tenantId, projected: true });
		const app = redirects(() => start);
		expect((await open(app, 'abuser-2')).status).toBe(410);
		expect((await open(app, 'bystander-1')).status).toBe(302);

		// A billing change writes new limits; it must not lift the suspension.
		await updatePolicy(identity(), stores(), target.tenantId, { ...limits, domainLimit: 3 }, start);
		expect(
			(
				await open(
					redirects(() => start),
					'abuser-2'
				)
			).status
		).toBe(410);
		expect(
			(
				await suspendTenant(identity(), stores(), operator, {
					tenantId: target.tenantId,
					reason: 'spam',
					now: start
				})
			).status
		).toBe('unchanged');

		await reinstateTenant(identity(), stores(), operator, {
			tenantId: target.tenantId,
			now: start
		});
		const after = redirects(() => start);
		expect((await open(after, 'abuser-2')).status).toBe(302);
		expect((await open(after, 'abuser-1')).status).toBe(410);
	});

	it('reaches routing through the projection retry when the first projection fails', async () => {
		const { tenantId } = await addWorkspace('deferred');
		await addLink(tenantId, 'deferred-1');
		const result = await suspendTenant(
			identity(),
			{ routing: env.BROKEN_ROUTING, analytics: stores().analytics },
			operator,
			{ tenantId, reason: 'malware', now: start }
		);
		expect(result).toEqual({ status: 'changed', tenantId, projected: false });
		expect(
			(
				await open(
					redirects(() => start),
					'deferred-1'
				)
			).status
		).toBe(302);
		await retryProjections(identity(), stores(), start, 100);
		expect(
			(
				await open(
					redirects(() => start),
					'deferred-1'
				)
			).status
		).toBe(410);
	});

	it('leaves the dashboard able to read and the owner able to export, and refuses changes', async () => {
		const { tenantId, userId } = await addWorkspace('readonly');
		const linkId = await addLink(tenantId, 'readonly-1');
		await suspendTenant(identity(), stores(), operator, { tenantId, reason: 'spam', now: start });

		expect((await call(userId, '/links')).status).toBe(200);
		const create = await call(userId, '/links', {
			method: 'POST',
			headers: { 'idempotency-key': 'k1' },
			body: JSON.stringify({ destination: 'https://example.com/new' })
		});
		expect(create.status).toBe(403);
		expect(errorCode(create)).toBe('WORKSPACE_SUSPENDED');
		const edit = await call(userId, `/links/${linkId}`, {
			method: 'PATCH',
			body: JSON.stringify({ enabled: false })
		});
		expect(errorCode(edit)).toBe('WORKSPACE_SUSPENDED');
		// Ending a token takes nothing new, so it passes the suspension check.
		const revoke = await call(userId, '/tokens/no-token', { method: 'DELETE' });
		expect(errorCode(revoke)).toBe('NOT_FOUND');

		const tokenList = await call(userId, '/links', { token: tenantId });
		expect(errorCode(tokenList)).toBe('WORKSPACE_SUSPENDED');
		expect((await call(userId, '/export/links', { token: tenantId })).status).toBe(200);
		expect((await call(userId, '/me', { token: tenantId })).status).toBe(200);

		await reinstateTenant(identity(), stores(), operator, { tenantId, now: start });
		expect((await call(userId, '/links', { token: tenantId })).status).toBe(200);
	});

	it('does not apply to a tenant whose deletion has started', async () => {
		const { tenantId, userId } = await addWorkspace('leaving');
		await identity()
			.prepare(
				"INSERT INTO tenant_deletions (tenant_id, user_id, analytics_shard_id, state, step, requested_at, next_attempt_at) VALUES (?, ?, 'analytics-1', 'running', 'accepted', 0, 0)"
			)
			.bind(tenantId, userId)
			.run();
		expect(
			await suspendTenant(identity(), stores(), operator, { tenantId, reason: 'spam', now: start })
		).toEqual({ status: 'not_found' });
	});
});

describe('deletion during a suspension', () => {
	it('refuses to delete a suspended workspace and keeps its credentials', async () => {
		const { tenantId, userId } = await addWorkspace('frozen');
		await identity()
			.prepare(
				'INSERT INTO "session" (id, expiresAt, token, createdAt, updatedAt, userId) VALUES (?, ?, ?, 0, 0, ?)'
			)
			.bind('session-frozen', start + 86400000, 'token-frozen', userId)
			.run();
		await suspendTenant(identity(), stores(), operator, {
			tenantId,
			reason: 'phishing',
			now: start
		});
		expect(await requestDeletion(identity(), userId, start)).toEqual({
			status: 'suspended',
			tenantId
		});
		expect(await count(identity(), 'tenant_deletions WHERE tenant_id = ?', tenantId)).toBe(0);
		expect(await count(identity(), '"session" WHERE "userId" = ?', userId)).toBe(1);
		// The batch checks again, for a suspension that lands after the first check.
		expect(
			await createDeletion(identity(), {
				tenantId,
				userId,
				analyticsShardId: 'analytics-1',
				contactEmail: null,
				now: start
			})
		).toBe(false);
		expect(await count(identity(), 'tenant_deletions WHERE tenant_id = ?', tenantId)).toBe(0);
		expect(await count(identity(), '"session" WHERE "userId" = ?', userId)).toBe(1);

		await reinstateTenant(identity(), stores(), operator, { tenantId, now: start });
		expect(await requestDeletion(identity(), userId, start)).toEqual({
			status: 'started',
			tenantId
		});
		expect(await count(identity(), '"session" WHERE "userId" = ?', userId)).toBe(0);
		// A suspension cannot land on a workspace that is being deleted.
		expect(
			await suspendTenant(identity(), stores(), operator, { tenantId, reason: 'spam', now: start })
		).toEqual({ status: 'not_found' });
	});
});

describe('access revocation', () => {
	it('ends the sessions, tokens, and connected apps of one tenant only', async () => {
		const target = await addWorkspace('revoked');
		const other = await addWorkspace('untouched');
		for (const { tenantId, userId } of [target, other])
			await identity().batch([
				identity()
					.prepare(
						'INSERT INTO "session" (id, expiresAt, token, createdAt, updatedAt, userId) VALUES (?, ?, ?, 0, 0, ?)'
					)
					.bind(`session-${userId}`, start + 86400000, `token-${userId}`, userId),
				identity()
					.prepare(
						'INSERT INTO "apikey" (id, referenceId, key, createdAt, updatedAt) VALUES (?, ?, ?, 0, 0)'
					)
					.bind(`key-${userId}`, userId, `hash-${userId}`),
				identity()
					.prepare(
						'INSERT INTO "oauthClient" (id, clientId, redirectUris) VALUES (?, ?, \'["https://app.example/cb"]\')'
					)
					.bind(`client-${userId}`, `client-${userId}`),
				identity()
					.prepare(
						'INSERT INTO "oauthConsent" (id, clientId, userId, referenceId, scopes) VALUES (?, ?, ?, ?, \'links:read\')'
					)
					.bind(`consent-${userId}`, `client-${userId}`, userId, tenantId)
			]);

		await revokeCustomerAccess(identity(), operator, { tenantId: target.tenantId });
		for (const table of ['"session"', '"apikey"', '"oauthConsent"']) {
			const column = table === '"apikey"' ? '"referenceId"' : '"userId"';
			expect(await count(identity(), `${table} WHERE ${column} = ?`, target.userId), table).toBe(0);
			expect(await count(identity(), `${table} WHERE ${column} = ?`, other.userId), table).toBe(1);
		}
	});
});
