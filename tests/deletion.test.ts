// SPDX-License-Identifier: AGPL-3.0-only
// Workspace deletion against real D1: credentials end at once, redirects stop, the job resumes,
// other workspaces keep every row, reservations stay, and a single installation closes.
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ClickEvent } from '../packages/contracts/src/analytics';
import { findRedirectTarget } from '../packages/data/src/links';
import { createTenant, updateTenantPolicy } from '../packages/data/src/tenancy';
import { createClickConsumer, type QueueMessage } from '../packages/server/src/analytics';
import { createApi } from '../packages/server/src/api';
import {
	cleanupDeletions,
	requestDeletion,
	routeSettleMs,
	runDeletions,
	type DeletionDependencies
} from '../packages/server/src/deletion';
import type { ProviderDomain } from '../packages/server/src/domains';
import type { EmailContent } from '../packages/server/src/email/transport';
import { projectPolicy, retryProjections, updatePolicy } from '../packages/server/src/tenancy';

const identity = () => env.DELETION_IDENTITY;
const routing = () => env.DELETION_ROUTING;
const shard = () => env.DELETION_ANALYTICS;
const shards = () => ({ 'analytics-1': shard() });
const stores = () => ({ routing: routing(), analytics: shards() });
const start = Date.UTC(2026, 9, 20, 12);
const limits = { activeLinkLimit: 100, monthlyClickLimit: 5000, retentionDays: 30, domainLimit: 1 };

const sent: EmailContent[] = [];
const stopped: ProviderDomain[] = [];
const extended: string[] = [];
let failExtension = false;
let failEmail = false;

function deps(now: number, change: Partial<DeletionDependencies> = {}): DeletionDependencies {
	return {
		identity: identity(),
		routing: routing(),
		shards: shards(),
		domains: {
			reservedHostnames: [],
			provider: {
				setup: 'dns',
				records: () => [],
				start: async () => ({ status: 'waiting' }),
				check: async () => ({ status: 'ready' }),
				stop: async (domain) => {
					stopped.push(domain);
				}
			}
		},
		email: {
			transport: {
				send: async (message) => {
					if (failEmail) throw new Error('Send failed');
					sent.push(message);
				}
			}
		},
		extension: async ({ tenantId }) => {
			if (failExtension) throw new Error('Extension failed');
			extended.push(tenantId);
		},
		now: () => now,
		...change
	};
}

async function addWorkspace(name: string, db = identity()): Promise<string> {
	const tenantId = `t-${name}`;
	const userId = `user-${name}`;
	await db
		.prepare(
			'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 0, 0)'
		)
		.bind(userId, '', `${name}@example.com`)
		.run();
	await createTenant(db, {
		id: tenantId,
		name: 'Workspace',
		ownerUserId: userId,
		analyticsShardId: 'analytics-1',
		limits,
		now: 1
	});
	if (db !== identity()) return tenantId;
	await projectPolicy(db, stores(), tenantId, 1);
	await db.batch([
		db
			.prepare(
				'INSERT INTO "session" (id, expiresAt, token, createdAt, updatedAt, userId) VALUES (?, ?, ?, 0, 0, ?)'
			)
			.bind(`session-${name}`, start + 86400000, `token-${name}`, userId),
		db
			.prepare(
				'INSERT INTO "apikey" (id, referenceId, key, createdAt, updatedAt) VALUES (?, ?, ?, 0, 0)'
			)
			.bind(`key-${name}`, userId, `hash-${name}`),
		db
			.prepare(
				'INSERT INTO "oauthClient" (id, clientId, redirectUris) VALUES (?, ?, \'["https://app.example/cb"]\')'
			)
			.bind(`client-${name}`, `client-${name}`),
		db
			.prepare(
				'INSERT INTO "oauthConsent" (id, clientId, userId, referenceId, scopes) VALUES (?, ?, ?, ?, \'links:read\')'
			)
			.bind(`consent-${name}`, `client-${name}`, userId, tenantId),
		db
			.prepare(
				"INSERT INTO notices (id, tenant_id, kind, dedupe_key, params, created_at) VALUES (?, ?, 'usage', ?, '{}', 0)"
			)
			.bind(`notice-${name}`, tenantId, `usage:${name}`)
	]);
	const brand = `go.${name}.example`;
	await routing().batch([
		routing()
			.prepare('INSERT INTO domain_namespaces (id, hostname, created_at) VALUES (?, ?, 0)')
			.bind(`dom-${name}`, brand),
		routing()
			.prepare(
				"INSERT INTO domains (id, tenant_id, state, is_default, created_at, updated_at, claimed_at) VALUES (?, ?, 'active', 0, 0, 0, 1)"
			)
			.bind(`dom-${name}`, tenantId),
		...[`dom-short`, `dom-${name}`].flatMap((domainId, index) => [
			routing()
				.prepare('INSERT INTO slug_reservations (domain_id, slug) VALUES (?, ?)')
				.bind(domainId, `${name}-${index}`),
			routing()
				.prepare(
					"INSERT INTO links (id, tenant_id, domain_id, slug, destination, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'https://example.com/a', NULL, 'active', 0, 0)"
				)
				.bind(`link-${name}-${index}`, tenantId, domainId, `${name}-${index}`)
		]),
		routing()
			.prepare(
				"INSERT INTO idempotency_records (tenant_id, key, request_hash, outcome, created_at, expires_at) VALUES (?, 'k', 'h', 'created', 0, ?)"
			)
			.bind(tenantId, start + 86400000)
	]);
	await shard().batch([
		shard()
			.prepare(
				"INSERT INTO daily_totals (tenant_id, link_id, day, clicks) VALUES (?, ?, '2026-10-19', 3)"
			)
			.bind(tenantId, `link-${name}-0`),
		shard()
			.prepare(
				"INSERT INTO daily_dimensions (tenant_id, link_id, day, dimension, value, clicks) VALUES (?, ?, '2026-10-19', 'country', 'JP', 3)"
			)
			.bind(tenantId, `link-${name}-0`),
		shard()
			.prepare("INSERT INTO monthly_usage (tenant_id, month, clicks) VALUES (?, '2026-10', 3)")
			.bind(tenantId)
	]);
	return tenantId;
}

async function rows(db: D1Database, sql: string, ...values: unknown[]): Promise<number> {
	const row = await db
		.prepare(`SELECT COUNT(*) AS n FROM ${sql}`)
		.bind(...values)
		.first<{ n: number }>();
	return row?.n ?? -1;
}

function click(tenantId: string): {
	value: QueueMessage;
	state: { acked: boolean; retried: boolean };
} {
	const body: ClickEvent = {
		schemaVersion: 1,
		eventId: crypto.randomUUID(),
		tenantId,
		analyticsShardId: 'analytics-1',
		linkId: 'link-late',
		kind: 'production',
		occurredAt: start,
		country: 'JP',
		deviceCategory: 'mobile',
		referrerHostname: 'unknown'
	};
	const state = { acked: false, retried: false };
	return {
		value: {
			body,
			ack: () => {
				state.acked = true;
			},
			retry: () => {
				state.retried = true;
			}
		},
		state
	};
}

beforeAll(async () => {
	for (const db of [identity(), env.DELETION_SINGLE_IDENTITY])
		await applyD1Migrations(db, env.IDENTITY_MIGRATIONS, 'flared_core_migrations');
	await applyD1Migrations(routing(), env.ROUTING_MIGRATIONS, 'flared_core_migrations');
	await applyD1Migrations(shard(), env.ANALYTICS_MIGRATIONS, 'flared_core_migrations');
	await identity()
		.prepare("INSERT INTO installation (id, mode, created_at) VALUES (1, 'multi', 0)")
		.run();
	await env.DELETION_SINGLE_IDENTITY.prepare(
		"INSERT INTO installation (id, mode, fixed_tenant_id, created_at) VALUES (1, 'single', 't-solo', 0)"
	).run();
	await routing().batch([
		routing().prepare(
			"INSERT INTO domain_namespaces (id, hostname, created_at) VALUES ('dom-short', 'short.example', 0)"
		),
		routing().prepare(
			"INSERT INTO domains (id, tenant_id, state, is_default, created_at, updated_at) VALUES ('dom-short', NULL, 'active', 1, 0, 0)"
		)
	]);
	await addWorkspace('gone');
	await addWorkspace('kept');
});

describe('workspace deletion', () => {
	it('ends every credential at once and refuses the API, once per workspace', async () => {
		// An outstanding projection must not bring the routing policy back later.
		await updateTenantPolicy(identity(), 't-gone', { ...limits, activeLinkLimit: 50 }, 2);
		expect(
			await requestDeletion(identity(), { userId: 'user-gone', tenantId: 't-gone' }, start)
		).toEqual({
			status: 'started',
			tenantId: 't-gone'
		});
		expect(
			await requestDeletion(identity(), { userId: 'user-gone', tenantId: 't-gone' }, start)
		).toEqual({
			status: 'already_deleting',
			tenantId: 't-gone'
		});
		expect(
			await requestDeletion(identity(), { userId: 'user-nobody', tenantId: 't-gone' }, start)
		).toEqual({
			status: 'no_workspace'
		});
		for (const table of ['"session"', '"apikey"', '"oauthConsent"'])
			expect(
				await rows(
					identity(),
					`${table} WHERE ${table === '"apikey"' ? '"referenceId"' : '"userId"'} = ?`,
					'user-gone'
				),
				table
			).toBe(0);
		expect(await rows(identity(), '"session" WHERE "userId" = ?', 'user-kept')).toBe(1);

		const api = createApi({
			identity: identity(),
			routing: routing(),
			analytics: shards(),
			appOrigin: 'https://app.example',
			authenticate: async (request) => ({
				kind: 'session',
				userId: request.headers.get('x-test-user') ?? '',
				sessionId: 'session-test',
				signedInAt: ''
			})
		});
		const refused = await api.fetch(
			new Request('https://app.example/v1/links', { headers: { 'x-test-user': 'user-gone' } })
		);
		expect(refused.status).toBe(409);
		expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
			'ACCOUNT_DELETING'
		);
		const kept = await api.fetch(
			new Request('https://app.example/v1/links', { headers: { 'x-test-user': 'user-kept' } })
		);
		expect(kept.status).toBe(200);
		await expect(updatePolicy(identity(), stores(), 't-gone', limits, start)).rejects.toThrow();
	});

	it('stops redirects and waits out the snapshots before deleting data', async () => {
		expect(await runDeletions(deps(start))).toEqual({ completed: 0, failed: 0 });
		expect(sent.map((email) => [email.to, email.subject])).toEqual([
			['gone@example.com', 'We are deleting your Flared account']
		]);
		expect(sent[0].text).not.toContain('did not ask');
		expect(await findRedirectTarget(routing(), 'short.example', 'gone-0')).toBeNull();
		expect(await findRedirectTarget(routing(), 'go.gone.example', 'gone-1')).toBeNull();
		expect(await findRedirectTarget(routing(), 'short.example', 'kept-0')).not.toBeNull();
		expect(stopped.map((domain) => domain.hostname)).toEqual(['go.gone.example']);
		await retryProjections(identity(), stores(), start, 100);
		expect(await rows(routing(), 'tenant_policy WHERE tenant_id = ?', 't-gone')).toBe(0);

		// Before the snapshots expire, no data is deleted.
		await identity().prepare('UPDATE tenant_deletions SET next_attempt_at = 0').run();
		await runDeletions(deps(start + routeSettleMs - 1000));
		expect(await rows(routing(), 'links WHERE tenant_id = ?', 't-gone')).toBe(2);
		expect(await rows(shard(), 'daily_totals WHERE tenant_id = ?', 't-gone')).toBe(1);
	});

	it('resumes after a failed step and deletes only this workspace', async () => {
		failExtension = true;
		await identity().prepare('UPDATE tenant_deletions SET next_attempt_at = 0').run();
		expect(await runDeletions(deps(start + routeSettleMs))).toEqual({ completed: 0, failed: 1 });
		const failed = await identity()
			.prepare('SELECT step, last_error_code, next_attempt_at FROM tenant_deletions')
			.first<{ step: string; last_error_code: string; next_attempt_at: number }>();
		expect(failed?.step).toBe('extension');
		expect(failed?.last_error_code).toBe('Error');
		expect(failed?.next_attempt_at).toBeGreaterThan(start + routeSettleMs);
		// Analytics and links are gone; a late click is dropped, not retried.
		expect(await rows(shard(), 'daily_totals WHERE tenant_id = ?', 't-gone')).toBe(0);
		expect(await rows(shard(), 'monthly_usage WHERE tenant_id = ?', 't-gone')).toBe(0);
		expect(await rows(routing(), 'links WHERE tenant_id = ?', 't-gone')).toBe(0);
		expect(await rows(routing(), 'idempotency_records WHERE tenant_id = ?', 't-gone')).toBe(0);
		const late = click('t-gone');
		await createClickConsumer({ shards: shards(), now: () => start })({ messages: [late.value] });
		expect(late.state).toEqual({ acked: true, retried: false });

		failExtension = false;
		await runDeletions(deps(start + 10 * 60000));
		expect(extended).toEqual(['t-gone']);
		const done = await identity()
			.prepare('SELECT state, contact_email FROM tenant_deletions WHERE tenant_id = ?')
			.bind('t-gone')
			.first<{ state: string; contact_email: string | null }>();
		expect(done).toEqual({ state: 'completed', contact_email: null });
		expect(sent.map((email) => email.subject)).toEqual([
			'We are deleting your Flared account',
			'Your Flared account is deleted'
		]);
		for (const table of [
			'tenants WHERE id = ?',
			'tenant_policy WHERE tenant_id = ?',
			'notices WHERE tenant_id = ?',
			'tenant_memberships WHERE tenant_id = ?'
		])
			expect(await rows(identity(), table, 't-gone'), table).toBe(0);
		expect(await rows(identity(), '"user" WHERE id = ?', 'user-gone')).toBe(0);
		// Addresses stay reserved; the domain row stays disabled.
		expect(await rows(routing(), "slug_reservations WHERE slug LIKE 'gone-%'")).toBe(2);
		expect(await rows(routing(), "domains WHERE id = 'dom-gone' AND state = 'disabled'")).toBe(1);
		// The other workspace keeps everything.
		expect(await rows(routing(), 'links WHERE tenant_id = ?', 't-kept')).toBe(2);
		expect(await rows(shard(), 'daily_totals WHERE tenant_id = ?', 't-kept')).toBe(1);
		expect(await rows(identity(), '"user" WHERE id = ?', 'user-kept')).toBe(1);
		expect(await rows(identity(), 'notices WHERE tenant_id = ?', 't-kept')).toBe(1);

		// The same email can sign up again into a new workspace.
		await identity()
			.prepare(
				"INSERT INTO \"user\" (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('user-again', '', 'gone@example.com', 1, 0, 0)"
			)
			.run();
		await createTenant(identity(), {
			id: 't-again',
			name: 'Workspace',
			ownerUserId: 'user-again',
			analyticsShardId: 'analytics-1',
			limits,
			now: 3
		});
		expect(await rows(identity(), 'tenant_memberships WHERE user_id = ?', 'user-again')).toBe(1);
	});

	it('sends each email once even when a send fails, and keeps the ledger for 90 days', async () => {
		await addWorkspace('quiet');
		failEmail = true;
		await requestDeletion(identity(), { userId: 'user-quiet', tenantId: 't-quiet' }, start);
		await runDeletions(deps(start), { tenantId: 't-quiet' });
		await identity().prepare('UPDATE tenant_deletions SET next_attempt_at = 0').run();
		await runDeletions(deps(start + routeSettleMs), { tenantId: 't-quiet' });
		failEmail = false;
		const job = await identity()
			.prepare('SELECT state FROM tenant_deletions WHERE tenant_id = ?')
			.bind('t-quiet')
			.first<{ state: string }>();
		expect(job?.state).toBe('completed');
		expect(sent.filter((email) => email.to === 'quiet@example.com')).toEqual([]);

		expect(await cleanupDeletions(identity(), start + 89 * 86400000)).toBe(0);
		expect(await cleanupDeletions(identity(), start + 91 * 86400000)).toBeGreaterThan(0);
	});

	it('closes a single-workspace installation for good', async () => {
		const db = env.DELETION_SINGLE_IDENTITY;
		await addWorkspace('solo', db);
		await db
			.prepare(
				"INSERT INTO tenant_deletions (tenant_id, user_id, analytics_shard_id, state, step, requested_at, next_attempt_at, routes_stopped_at) VALUES ('t-solo', 'user-solo', 'analytics-1', 'running', 'identity', 0, 0, 0)"
			)
			.run();
		await runDeletions(deps(start, { identity: db }));
		expect(await rows(db, 'tenants')).toBe(0);
		await expect(
			createTenant(db, {
				id: 't-solo',
				name: 'Workspace',
				ownerUserId: 'user-solo',
				analyticsShardId: 'analytics-1',
				limits,
				now: 2
			})
		).rejects.toThrow();
	});
});
