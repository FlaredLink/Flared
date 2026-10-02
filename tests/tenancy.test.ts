// SPDX-License-Identifier: AGPL-3.0-only
import { env } from 'cloudflare:workers';
import { applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { applyRoutingPolicy } from '../packages/data/src/routing-policy';
import { createTenant, readInstallationMode, type NewTenant } from '../packages/data/src/tenancy';
import {
	projectRoutingPolicy,
	resolveTenant,
	retryRoutingProjections,
	TenancyError
} from '../packages/server/src/tenancy';

declare global {
	namespace Cloudflare {
		interface Env {
			UNCONFIGURED_IDENTITY: D1Database;
			SINGLE_IDENTITY: D1Database;
			MULTI_IDENTITY: D1Database;
			ROUTING: D1Database;
			IDENTITY_MIGRATIONS: D1Migration[];
			ROUTING_MIGRATIONS: D1Migration[];
		}
	}
}

const limits = { activeLinkLimit: 100, monthlyClickLimit: 5000, retentionDays: 30, domainLimit: 1 };

async function addUser(db: D1Database, id: string): Promise<void> {
	await db
		.prepare(
			'INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 0, 0)'
		)
		.bind(id, '', `${id}@example.com`)
		.run();
}

function tenant(id: string, ownerUserId: string): NewTenant {
	return { id, name: 'Workspace', ownerUserId, analyticsShardId: 'analytics-1', limits, now: 1 };
}

async function routingRow(tenantId: string) {
	return env.ROUTING.prepare(
		'SELECT revision, analytics_shard_id, active_link_limit, domain_limit FROM tenant_policy WHERE tenant_id = ?'
	)
		.bind(tenantId)
		.first();
}

const unavailableRouting = {
	prepare() {
		throw new Error('routing unavailable');
	}
} as unknown as D1Database;

beforeAll(async () => {
	for (const db of [env.UNCONFIGURED_IDENTITY, env.SINGLE_IDENTITY, env.MULTI_IDENTITY])
		await applyD1Migrations(db, env.IDENTITY_MIGRATIONS, 'flared_core_migrations');
	await applyD1Migrations(env.ROUTING, env.ROUTING_MIGRATIONS, 'flared_core_migrations');
	await env.SINGLE_IDENTITY.prepare(
		"INSERT INTO installation (id, mode, created_at) VALUES (1, 'single', 0)"
	).run();
	await env.MULTI_IDENTITY.prepare(
		"INSERT INTO installation (id, mode, created_at) VALUES (1, 'multi', 0)"
	).run();
});

describe('installation guard', () => {
	it('refuses tenants until the deployment records an installation', async () => {
		const db = env.UNCONFIGURED_IDENTITY;
		await addUser(db, 'user-unconfigured');
		expect(await readInstallationMode(db)).toBeNull();
		await expect(createTenant(db, tenant('t-unconfigured', 'user-unconfigured'))).rejects.toThrow(
			'installation is not configured'
		);
		expect(await resolveTenant(db, 'user-unconfigured')).toEqual({ status: 'none' });
	});

	it('keeps one installation row with a fixed mode', async () => {
		const db = env.MULTI_IDENTITY;
		expect(await readInstallationMode(db)).toBe('multi');
		await expect(db.prepare("UPDATE installation SET mode = 'single'").run()).rejects.toThrow();
		await expect(db.prepare('DELETE FROM installation').run()).rejects.toThrow();
		await expect(
			db.prepare("INSERT INTO installation (id, mode, created_at) VALUES (2, 'multi', 0)").run()
		).rejects.toThrow();
		expect(await readInstallationMode(db)).toBe('multi');
	});
});

describe('single mode', () => {
	it('accepts exactly one tenant, including under concurrent attempts', async () => {
		const db = env.SINGLE_IDENTITY;
		await addUser(db, 'single-a');
		await addUser(db, 'single-b');
		const results = await Promise.allSettled([
			createTenant(db, tenant('single-tenant-a', 'single-a')),
			createTenant(db, tenant('single-tenant-b', 'single-b'))
		]);
		expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
		await addUser(db, 'single-c');
		await expect(createTenant(db, tenant('single-tenant-c', 'single-c'))).rejects.toThrow();
		const tenants = await db
			.prepare(
				'SELECT (SELECT COUNT(*) FROM tenants) AS tenants, (SELECT COUNT(*) FROM tenant_memberships) AS memberships, (SELECT COUNT(*) FROM tenant_policy) AS policies'
			)
			.first();
		expect(tenants).toEqual({ tenants: 1, memberships: 1, policies: 1 });
	});
});

describe('multi mode', () => {
	it('gives one user one tenant when two creations race', async () => {
		const db = env.MULTI_IDENTITY;
		await addUser(db, 'race');
		const results = await Promise.allSettled([
			createTenant(db, tenant('race-1', 'race')),
			createTenant(db, tenant('race-2', 'race'))
		]);
		expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
		const resolved = await resolveTenant(db, 'race');
		expect(resolved.status).toBe('pending');
		const rows = await db
			.prepare("SELECT COUNT(*) AS n FROM tenants WHERE id IN ('race-1', 'race-2')")
			.first<{ n: number }>();
		expect(rows?.n).toBe(1);
	});

	it('keeps different users in different tenants', async () => {
		const db = env.MULTI_IDENTITY;
		await addUser(db, 'owner-a');
		await addUser(db, 'owner-b');
		await createTenant(db, tenant('tenant-a', 'owner-a'));
		await createTenant(db, tenant('tenant-b', 'owner-b'));
		expect(await resolveTenant(db, 'owner-a')).toEqual({ status: 'pending', tenantId: 'tenant-a' });
		expect(await resolveTenant(db, 'owner-b')).toEqual({ status: 'pending', tenantId: 'tenant-b' });
		expect(await resolveTenant(db, 'nobody')).toEqual({ status: 'none' });
	});

	it('rejects invalid limits and blocks deleting a user who owns a tenant', async () => {
		const db = env.MULTI_IDENTITY;
		await addUser(db, 'owner-invalid');
		await expect(
			createTenant(db, {
				...tenant('tenant-invalid', 'owner-invalid'),
				limits: { ...limits, retentionDays: 0 }
			})
		).rejects.toThrow('Invalid policy limits');
		await expect(db.prepare("DELETE FROM user WHERE id = 'owner-a'").run()).rejects.toThrow();
	});
});

describe('policy projection', () => {
	it('keeps a tenant pending until routing holds its policy', async () => {
		const db = env.MULTI_IDENTITY;
		await addUser(db, 'owner-project');
		await createTenant(db, tenant('tenant-project', 'owner-project'));
		await expect(
			projectRoutingPolicy(db, unavailableRouting, 'tenant-project', 10)
		).rejects.toThrow();
		expect((await resolveTenant(db, 'owner-project')).status).toBe('pending');
		await projectRoutingPolicy(db, env.ROUTING, 'tenant-project', 11);
		expect(await resolveTenant(db, 'owner-project')).toEqual({
			status: 'active',
			tenantId: 'tenant-project'
		});
		expect(await routingRow('tenant-project')).toEqual({
			revision: 1,
			analytics_shard_id: 'analytics-1',
			active_link_limit: 100,
			domain_limit: 1
		});
		await projectRoutingPolicy(db, env.ROUTING, 'tenant-project', 12);
		expect((await routingRow('tenant-project'))?.revision).toBe(1);
	});

	it('applies only a newer revision', async () => {
		const db = env.MULTI_IDENTITY;
		await db
			.prepare(
				"UPDATE tenant_policy SET revision = 2, active_link_limit = 10000, updated_at = 20 WHERE tenant_id = 'tenant-project'"
			)
			.run();
		await projectRoutingPolicy(db, env.ROUTING, 'tenant-project', 21);
		expect((await routingRow('tenant-project'))?.active_link_limit).toBe(10000);
		await applyRoutingPolicy(env.ROUTING, {
			tenantId: 'tenant-project',
			revision: 1,
			analyticsShardId: 'analytics-1',
			activeLinkLimit: 100,
			domainLimit: 1,
			now: 22
		});
		expect(await routingRow('tenant-project')).toMatchObject({
			revision: 2,
			active_link_limit: 10000
		});
	});

	it('retries only outstanding projections', async () => {
		const db = env.MULTI_IDENTITY;
		const result = await retryRoutingProjections(db, env.ROUTING, 30, 100);
		// race winner, tenant-a, tenant-b
		expect(result).toEqual({ projected: 3, failed: 0 });
		expect((await resolveTenant(db, 'owner-a')).status).toBe('active');
		expect(await retryRoutingProjections(db, env.ROUTING, 31, 100)).toEqual({
			projected: 0,
			failed: 0
		});
		await expect(retryRoutingProjections(db, env.ROUTING, 32, 101)).rejects.toThrow();
	});

	it('fails closed when a user has two memberships', async () => {
		const db = env.MULTI_IDENTITY;
		// Simulates the later team schema, which removes the one-workspace index.
		await db.prepare('DROP INDEX tenant_memberships_one_per_user').run();
		await db
			.prepare(
				"INSERT INTO tenants (id, name, analytics_shard_id, created_at) VALUES ('tenant-extra', 'x', 'analytics-1', 5)"
			)
			.run();
		await db
			.prepare(
				"INSERT INTO tenant_memberships (tenant_id, user_id, role, created_at) VALUES ('tenant-extra', 'owner-a', 'owner', 5)"
			)
			.run();
		await expect(resolveTenant(db, 'owner-a')).rejects.toBeInstanceOf(TenancyError);
	});
});
