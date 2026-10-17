// SPDX-License-Identifier: AGPL-3.0-only
// Routing migration 0010 rebuilds automations and link_automations: every row stays, the cascade
// and the foreign key still hold, and the indexes match 0009.
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

const db = () => env.MIGRATION_ROUTING;
const rebuiltIndexes = [
	'automations_tenant',
	'link_automations_due',
	'link_automations_checks',
	'link_automations_automation',
	'link_automations_tenant'
];

async function indexSql(names: readonly string[]): Promise<Record<string, unknown>[]> {
	const { results } = await db()
		.prepare(
			"SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index' AND name IN (SELECT value FROM json_each(?)) ORDER BY name"
		)
		.bind(JSON.stringify(names))
		.all<Record<string, unknown>>();
	return results;
}

async function rows(sql: string): Promise<Record<string, unknown>[]> {
	return (await db().prepare(sql).all<Record<string, unknown>>()).results;
}

const applicationColumns =
	'tenant_id, link_id, automation_id, trigger_type, state, ends_at, due_at, reached_clicks, armed_at, claim_token, claimed_until, attempts, check_key, check_failures, last_checked_at, last_check_result, fired_at, result_code, created_at, updated_at';

let before: {
	automations: Record<string, unknown>[];
	applications: Record<string, unknown>[];
	runs: Record<string, unknown>[];
	indexes: Record<string, unknown>[];
};

beforeAll(async () => {
	const migrations = env.ROUTING_MIGRATIONS;
	const index = migrations.findIndex((item) => item.name.startsWith('0010_'));
	expect(index).toBeGreaterThan(0);
	await applyD1Migrations(db(), migrations.slice(0, index), 'flared_core_migrations');
	await db().batch([
		db().prepare(
			"INSERT INTO tenant_policy (tenant_id, revision, analytics_shard_id, active_link_limit, domain_limit, updated_at, webhook_endpoint_limit, automation_limit) VALUES ('t-old', 1, 'shard-1', 100, 1, 1, 5, 25)"
		),
		db().prepare(
			"INSERT INTO webhook_endpoints (id, tenant_id, url, events, key_id, created_at, updated_at) VALUES ('wh-1', 't-old', 'https://hooks.example.com/in', '[\"link.created\"]', 'key-1', 10, 10)"
		),
		db().prepare(
			`INSERT INTO automations (id, tenant_id, name, enabled, trigger_type, trigger_days, trigger_clicks, set_destination, disable_link, webhook_endpoint_id, email_owner, created_at, updated_at) VALUES
			('aut-a', 't-old', 'End of sale', 1, 'end_date', NULL, NULL, 'https://example.com/over', 1, 'wh-1', 1, 20, 21),
			('aut-b', 't-old', 'Old links', 0, 'link_age', 30, NULL, NULL, 1, NULL, 0, 22, 23),
			('aut-c', 't-old', 'Popular', 1, 'clicks', NULL, 1000, NULL, 0, 'wh-1', 0, 24, 25),
			('aut-d', 't-old', 'Down', 1, 'destination_down', NULL, NULL, NULL, 0, NULL, 1, 26, 27)`
		),
		// Inserted out of key order, so rowid order differs from the primary key.
		db().prepare(
			`INSERT INTO link_automations (${applicationColumns}) VALUES
			('t-old', 'link-9', 'aut-a', 'end_date', 'waiting', 5000, 5000, NULL, 30, 'claim-1', 6000, 2, NULL, 0, NULL, NULL, NULL, NULL, 30, 31),
			('t-old', 'link-1', 'aut-b', 'link_age', 'done', NULL, 4000, NULL, 32, NULL, NULL, 1, NULL, 0, NULL, NULL, 4100, NULL, 32, 33),
			('t-old', 'link-5', 'aut-c', 'clicks', 'failed', NULL, 4200, 1300, 34, NULL, NULL, 5, NULL, 0, NULL, NULL, 4300, 'attempts', 34, 35),
			('t-old', 'link-3', 'aut-d', 'destination_down', 'waiting', NULL, NULL, NULL, 36, NULL, NULL, 0, 'key-x', 1, 4400, '404', NULL, NULL, 36, 37),
			('t-old', 'link-1', 'aut-a', 'end_date', 'skipped', 3000, 3000, NULL, 38, NULL, NULL, 1, NULL, 0, NULL, NULL, 3100, 'plan', 38, 39)`
		),
		db().prepare(
			`INSERT INTO automation_runs (id, tenant_id, automation_id, automation_name, link_id, claim_token, state, result_code, actions, email, created_at) VALUES
			('run-1', 't-old', 'aut-b', 'Old links', 'link-1', 'claim-0', 'succeeded', NULL, '["disable_link"]', 0, 4100),
			('run-2', 't-old', 'aut-c', 'Popular', 'link-5', 'claim-2', 'failed', 'attempts', '[]', 0, 4300),
			('run-3', 't-old', 'aut-gone', 'Deleted', 'link-7', 'claim-3', 'skipped', 'off', '[]', 1, 4500)`
		)
	]);
	before = {
		automations: await rows('SELECT * FROM automations ORDER BY id'),
		applications: await rows(
			`SELECT rowid, ${applicationColumns} FROM link_automations ORDER BY rowid`
		),
		runs: await rows('SELECT * FROM automation_runs ORDER BY id'),
		indexes: await indexSql(rebuiltIndexes)
	};
	expect(before.applications).toHaveLength(5);
	await applyD1Migrations(db(), migrations, 'flared_core_migrations');
});

describe('routing migration 0010', () => {
	it('keeps every template, application, and run', async () => {
		expect(await rows('SELECT * FROM automations ORDER BY id')).toEqual(
			before.automations.map((row) => ({ ...row, message_endpoint_id: null }))
		);
		expect(
			await rows(`SELECT rowid, ${applicationColumns} FROM link_automations ORDER BY rowid`)
		).toEqual(before.applications);
		expect(await rows('SELECT * FROM automation_runs ORDER BY id')).toEqual(before.runs);
		expect(
			await rows("SELECT name FROM sqlite_master WHERE name LIKE '%\\_next' ESCAPE '\\'")
		).toEqual([]);
	});

	it('keeps the foreign key from link_automations to automations', async () => {
		const keys = await rows("SELECT * FROM pragma_foreign_key_list('link_automations')");
		expect(keys).toHaveLength(1);
		expect(keys[0]).toMatchObject({
			table: 'automations',
			from: 'automation_id',
			to: 'id',
			on_delete: 'CASCADE'
		});
		await expect(
			db()
				.prepare(
					"INSERT INTO link_automations (tenant_id, link_id, automation_id, trigger_type, armed_at, created_at, updated_at) VALUES ('t-old', 'link-2', 'aut-missing', 'end_date', 1, 1, 1)"
				)
				.run()
		).rejects.toThrow();
	});

	it('deletes the applications of a deleted template by cascade', async () => {
		await db().prepare("DELETE FROM automations WHERE id = 'aut-a'").run();
		expect(
			await rows("SELECT link_id FROM link_automations WHERE automation_id = 'aut-a'")
		).toEqual([]);
		expect(await rows('SELECT automation_id FROM link_automations ORDER BY automation_id')).toEqual(
			[{ automation_id: 'aut-b' }, { automation_id: 'aut-c' }, { automation_id: 'aut-d' }]
		);
	});

	it('rebuilds the indexes of 0009 and adds the transport indexes', async () => {
		expect(await indexSql(rebuiltIndexes)).toEqual(before.indexes);
		expect(before.indexes).toHaveLength(rebuiltIndexes.length);
		expect(
			(await indexSql(['webhook_endpoints_target', 'webhook_endpoints_transport'])).map(
				(row) => row.name
			)
		).toEqual(['webhook_endpoints_target', 'webhook_endpoints_transport']);
		const automationIndexes = await rows(
			"SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'automation_runs' AND name NOT LIKE 'sqlite_%' ORDER BY name"
		);
		expect(automationIndexes.map((row) => row.name)).toEqual([
			'automation_runs_automation',
			'automation_runs_claim',
			'automation_runs_created',
			'automation_runs_tenant'
		]);
	});

	it('makes existing and new endpoints http', async () => {
		await db()
			.prepare(
				"INSERT INTO webhook_endpoints (id, tenant_id, url, events, key_id, created_at, updated_at) VALUES ('wh-2', 't-old', 'https://hooks.example.com/two', '[]', 'key-1', 11, 11)"
			)
			.run();
		expect(
			await rows(
				'SELECT id, transport, target_key, target, off_reason FROM webhook_endpoints ORDER BY id'
			)
		).toEqual([
			{ id: 'wh-1', transport: 'http', target_key: null, target: null, off_reason: null },
			{ id: 'wh-2', transport: 'http', target_key: null, target: null, off_reason: null }
		]);
	});

	it('checks the new columns', async () => {
		const endpoint = (id: string, transport: string, key: string | null, reason: string | null) =>
			db()
				.prepare(
					"INSERT INTO webhook_endpoints (id, tenant_id, url, events, key_id, transport, target_key, target, off_reason, created_at, updated_at) VALUES (?, 't-old', 'https://chat.example.com/c', '[]', 'transport', ?, ?, '{\"channel\":\"C1\"}', ?, 12, 12)"
				)
				.bind(id, transport, key, reason)
				.run();
		await endpoint('tr-1', 'chat', 'alerts:C1', null);
		await expect(endpoint('tr-2', 'chat', 'alerts:C1', null)).rejects.toThrow();
		await endpoint('tr-3', 'other', 'alerts:C1', 'unauthorized');
		await expect(endpoint('tr-4', 'Chat', 'alerts:C2', null)).rejects.toThrow();
		await expect(endpoint('tr-5', 'chat', 'alerts:C3', 'gone')).rejects.toThrow();
		const template = (id: string, message: string | null) =>
			db()
				.prepare(
					"INSERT INTO automations (id, tenant_id, name, trigger_type, message_endpoint_id, created_at, updated_at) VALUES (?, 't-old', 'Post', 'end_date', ?, 1, 1)"
				)
				.bind(id, message)
				.run();
		await template('aut-post', 'tr-1');
		await expect(template('aut-none', null)).rejects.toThrow();
	});
});
