// SPDX-License-Identifier: AGPL-3.0-only
// The webhook data layer against real D1: link events staged with the change, the endpoint
// limit, fan-out, claims, results, milestone transfer, expiry, and retention.
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import type { CreateLinkInput } from '../packages/contracts/src/links';
import {
	parseCreateWebhook,
	parseUpdateWebhook,
	parseWebhookUrl,
	subscribableWebhookEvents
} from '../packages/contracts/src/webhooks';
import { readLink, setLinkBlock, updateLink, type LinkChange } from '../packages/data/src/links';
import { createTenant } from '../packages/data/src/tenancy';
import {
	claimWebhookDeliveries,
	createWebhookEndpoint,
	deleteClickMilestones,
	deleteOldWebhookRecords,
	deleteWebhookEndpoint,
	expireWebhookDeliveries,
	fanOutWebhookEvents,
	finishWebhookDeliveries,
	insertMilestoneEvents,
	insertTestEvent,
	linkJson,
	listEndpointDeliveries,
	listWebhookEndpoints,
	listWebhookEvents,
	readClaimedDeliveries,
	readClickMilestones,
	rotateWebhookSecret,
	updateWebhookEndpoint,
	webhookDeliveryLifetimeMs,
	webhookRecordLifetimeMs,
	type NewWebhookEndpoint
} from '../packages/data/src/webhooks';
import { parseImportItems, runImport } from '../packages/server/src/imports';
import { changeLink, createLink, toApiLink } from '../packages/server/src/links';
import { projectPolicy, updatePolicy } from '../packages/server/src/tenancy';
import { counting } from './support/d1-count';

const identity = () => env.WEBHOOKS_IDENTITY;
const routing = () => env.WEBHOOKS_ROUTING;
const shard = () => env.WEBHOOKS_ANALYTICS;
const stores = () => ({ routing: routing(), analytics: { 'analytics-1': shard() } });
const clock = Date.UTC(2026, 9, 17, 9, 12, 30, 123);
const minute = 60000;

const baseLimits = { monthlyClickLimit: 5000, retentionDays: 30, domainLimit: 1 };

async function addTenant(
	tenantId: string,
	limits: { webhookEndpointLimit?: number; activeLinkLimit?: number } = {}
): Promise<void> {
	await identity()
		.prepare(
			'INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 0, 0)'
		)
		.bind(`owner-${tenantId}`, '', `${tenantId}@example.com`)
		.run();
	await createTenant(identity(), {
		id: tenantId,
		name: 'Workspace',
		ownerUserId: `owner-${tenantId}`,
		analyticsShardId: 'analytics-1',
		limits: {
			...baseLimits,
			activeLinkLimit: limits.activeLinkLimit ?? 100,
			webhookEndpointLimit: limits.webhookEndpointLimit ?? 5
		},
		now: 1
	});
	await projectPolicy(identity(), stores(), tenantId, 1);
}

async function setWebhookLimit(tenantId: string, limit: number, now: number): Promise<void> {
	const result = await updatePolicy(
		identity(),
		stores(),
		tenantId,
		{ ...baseLimits, activeLinkLimit: 100, webhookEndpointLimit: limit },
		now
	);
	expect(result.projected).toBe(true);
}

let endpointCounter = 0;
async function addEndpoint(tenantId: string, change: Partial<NewWebhookEndpoint> = {}) {
	endpointCounter += 1;
	const result = await createWebhookEndpoint(routing(), {
		id: `hook-${endpointCounter}`,
		tenantId,
		url: 'https://hooks.example.com/in',
		events: [...subscribableWebhookEvents],
		milestoneInterval: 100,
		keyId: 'key-1',
		now: clock,
		...change
	});
	if (result.status !== 'created') throw new Error(`Endpoint not created: ${result.status}`);
	return result.endpoint;
}

function create(
	tenantId: string,
	key: string,
	input: Partial<CreateLinkInput> = {},
	options: { newSlug?: () => string; now?: number } = {}
) {
	return createLink(routing(), {
		tenantId,
		key,
		input: {
			destination: 'https://example.com/a',
			slug: null,
			title: null,
			domainId: null,
			iosDestination: null,
			androidDestination: null,
			...input
		},
		requestId: 'request-1',
		now: options.now ?? clock,
		newSlug: options.newSlug
	});
}

async function createdLinkId(result: { status: number; body: string }): Promise<string> {
	expect(result.status).toBe(201);
	const { link } = JSON.parse(result.body);
	return link.id;
}

const events = (tenantId: string) => listWebhookEvents(routing(), tenantId, 100);

let eventCounter = 0;
// Each change happens later than the one before, so the newest event comes first.
function change(fields: Partial<LinkChange>): LinkChange {
	eventCounter += 1;
	return { now: clock + eventCounter * 1000, eventId: `evt-change-${eventCounter}`, ...fields };
}

async function count(db: D1Database, sql: string, ...values: unknown[]): Promise<number> {
	const row = await db
		.prepare(`SELECT COUNT(*) AS n FROM ${sql}`)
		.bind(...values)
		.first<{ n: number }>();
	return row?.n ?? -1;
}

async function linkText(tenantId: string, linkId: string): Promise<string | null> {
	const row = await routing()
		.prepare(
			`SELECT ${linkJson('l', 'n')} AS link FROM links l JOIN domain_namespaces n ON n.id = l.domain_id WHERE l.tenant_id = ? AND l.id = ?`
		)
		.bind(tenantId, linkId)
		.first<{ link: string }>();
	return row?.link ?? null;
}

async function apiLinkText(tenantId: string, linkId: string): Promise<string> {
	const row = await readLink(routing(), tenantId, linkId);
	if (!row) throw new Error('Link not found');
	return JSON.stringify(toApiLink(row));
}

beforeAll(async () => {
	await applyD1Migrations(identity(), env.IDENTITY_MIGRATIONS, 'flared_core_migrations');
	await applyD1Migrations(routing(), env.ROUTING_MIGRATIONS, 'flared_core_migrations');
	await applyD1Migrations(shard(), env.ANALYTICS_MIGRATIONS, 'flared_core_migrations');
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

describe('link events', () => {
	it('stages link.created with the 201 body while an enabled endpoint exists', async () => {
		await addTenant('t-on');
		await addEndpoint('t-on');
		const result = await create('t-on', 'on-1', {
			destination: 'https://example.com/on?x=1&y=%20',
			slug: 'on-a',
			title: 'Say "hi" — ünïcødé ✓',
			iosDestination: 'myapp://on'
		});
		expect(result.eventStaged).toBe(true);
		const linkId = await createdLinkId(result);
		const [event] = await events('t-on');
		expect(event).toMatchObject({
			type: 'link.created',
			subjectId: linkId,
			targetEndpointId: null,
			createdAt: clock,
			fannedOutAt: null
		});
		expect(event.payload).toBe(result.body);
		// The SQL link is the API link, byte for byte, including the milliseconds.
		expect(await linkText('t-on', linkId)).toBe(await apiLinkText('t-on', linkId));
	});

	it('stages nothing without an enabled endpoint, at limit 0 or NULL, or when no link is stored', async () => {
		await addTenant('t-none');
		const none = await create('t-none', 'none-1');
		expect([none.status, none.eventStaged]).toEqual([201, false]);

		await addTenant('t-off');
		const off = await addEndpoint('t-off');
		await updateWebhookEndpoint(routing(), 't-off', off.id, { enabled: false, now: clock });
		expect((await create('t-off', 'off-1')).eventStaged).toBe(false);

		await addTenant('t-zero');
		await addEndpoint('t-zero');
		await setWebhookLimit('t-zero', 0, 2);
		expect((await create('t-zero', 'zero-1')).eventStaged).toBe(false);

		await addTenant('t-null');
		await addEndpoint('t-null');
		await routing()
			.prepare("UPDATE tenant_policy SET webhook_endpoint_limit = NULL WHERE tenant_id = 't-null'")
			.run();
		expect((await create('t-null', 'null-1')).eventStaged).toBe(false);
		for (const tenantId of ['t-none', 't-off', 't-zero', 't-null'])
			expect(await events(tenantId)).toEqual([]);

		const before = (await events('t-on')).length;
		const taken = await create('t-on', 'on-2', { slug: 'on-a' });
		expect([taken.status, taken.eventStaged]).toEqual([409, undefined]);
		const replayed = await create('t-on', 'on-1', {
			destination: 'https://example.com/on?x=1&y=%20',
			slug: 'on-a',
			title: 'Say "hi" — ünïcødé ✓',
			iosDestination: 'myapp://on'
		});
		expect([replayed.status, replayed.replayed, replayed.eventStaged]).toEqual([
			201,
			true,
			undefined
		]);
		// A generated slug that collides is retried; only the stored link has an event.
		const slugs = ['on-a', 'on-free'];
		const retried = await create('t-on', 'on-3', {}, { newSlug: () => slugs.shift() ?? 'x' });
		expect([retried.status, retried.eventStaged]).toEqual([201, true]);
		expect((await events('t-on')).length).toBe(before + 1);

		await addTenant('t-full', { activeLinkLimit: 1 });
		await addEndpoint('t-full');
		expect((await create('t-full', 'full-1')).eventStaged).toBe(true);
		const full = await create('t-full', 'full-2');
		expect([full.status, full.eventStaged]).toEqual([403, undefined]);
		expect((await events('t-full')).length).toBe(1);
	});

	it('stages one event per edit with the state before and after, and the type of the change', async () => {
		await addTenant('t-edit');
		await addEndpoint('t-edit');
		const linkId = await createdLinkId(
			await create('t-edit', 'edit-1', { destination: 'https://example.com/old', title: 'Old' })
		);
		// Milliseconds below 100 need their leading zeros.
		const later = clock + 880;
		const edited = await updateLink(
			routing(),
			't-edit',
			linkId,
			change({ destination: 'https://example.com/new', title: 'New', now: later })
		);
		expect(edited).toEqual({ updated: true, eventStaged: true });
		const [updated] = await events('t-edit');
		expect(updated.type).toBe('link.updated');
		const payload = JSON.parse(updated.payload);
		expect(Object.keys(payload)).toEqual(['link', 'previous']);
		expect(payload.previous).toEqual({
			destination: 'https://example.com/old',
			title: 'Old',
			iosDestination: null,
			androidDestination: null,
			enabled: true
		});
		const linkSql = await routing()
			.prepare("SELECT json_extract(payload, '$.link') AS link FROM webhook_events WHERE id = ?")
			.bind(updated.id)
			.first<{ link: string }>();
		expect(linkSql?.link).toBe(await apiLinkText('t-edit', linkId));
		expect(payload.link.updatedAt).toBe(new Date(later).toISOString());

		const off = await updateLink(routing(), 't-edit', linkId, change({ active: false }));
		expect(off).toEqual({ updated: true, eventStaged: true });
		expect((await events('t-edit'))[0].type).toBe('link.disabled');
		// Turning off a link that is off changes nothing an event reports.
		const again = await updateLink(routing(), 't-edit', linkId, change({ active: false }));
		expect(again).toEqual({ updated: true, eventStaged: false });
		// The state change wins the type.
		const on = await updateLink(
			routing(),
			't-edit',
			linkId,
			change({ active: true, title: 'Both' })
		);
		expect(on).toEqual({ updated: true, eventStaged: true });
		expect((await events('t-edit'))[0].type).toBe('link.enabled');
		expect((await events('t-edit')).map((event) => event.type)).toEqual([
			'link.enabled',
			'link.disabled',
			'link.updated',
			'link.created'
		]);

		// The server path stages the event too.
		await changeLink(routing(), 't-edit', linkId, { title: 'Server' }, clock + 100000);
		expect((await events('t-edit'))[0].type).toBe('link.updated');

		const missing = await updateLink(routing(), 't-edit', 'no-link', change({ title: 'x' }));
		expect(missing).toEqual({ updated: false, eventStaged: false });
		expect(await updateLink(routing(), 't-on', linkId, change({ title: 'x' }))).toEqual({
			updated: false,
			eventStaged: false
		});
	});

	it('stages nothing for a block or an edit refused for a block or the limit', async () => {
		await addTenant('t-block', { activeLinkLimit: 1 });
		await addEndpoint('t-block');
		const first = await createdLinkId(await create('t-block', 'block-1'));
		const staged = (await events('t-block')).length;
		expect(await setLinkBlock(routing(), first, { reason: 'spam', now: clock })).toEqual({
			tenantId: 't-block',
			changed: true
		});
		expect((await events('t-block')).length).toBe(staged);
		expect(
			await updateLink(routing(), 't-block', first, change({ destination: 'https://e.com/x' }))
		).toEqual({ updated: false, eventStaged: false });
		// The owner may still turn a blocked link off.
		expect(await updateLink(routing(), 't-block', first, change({ active: false }))).toEqual({
			updated: true,
			eventStaged: true
		});
		const disabled = (await events('t-block'))[0];
		expect(disabled.type).toBe('link.disabled');
		expect(JSON.parse(disabled.payload).link.blocked).toEqual({ reason: 'spam' });
		expect(await linkText('t-block', first)).toBe(await apiLinkText('t-block', first));
		await setLinkBlock(routing(), first, null);
		expect((await events('t-block')).length).toBe(staged + 1);

		await createdLinkId(await create('t-block', 'block-2'));
		expect(await updateLink(routing(), 't-block', first, change({ active: true }))).toEqual({
			updated: false,
			eventStaged: false
		});
		expect((await events('t-block')).length).toBe(staged + 2);
	});

	it('stages link.created only for the imported items that create a link', async () => {
		await addTenant('t-import');
		await addEndpoint('t-import');
		const items = parseImportItems([
			{ destination: 'https://example.com/one' },
			{ destination: 'ftp://example.com/bad' },
			{ destination: 'https://example.com/two' }
		]);
		const run = await runImport(routing(), {
			tenantId: 't-import',
			key: 'import-1',
			items,
			requestId: 'request-1',
			now: clock
		});
		expect(run.created).toBe(2);
		const staged = await events('t-import');
		expect(staged.map((event) => event.type)).toEqual(['link.created', 'link.created']);
	});
});

describe('endpoints', () => {
	it('keeps the endpoint limit under concurrent creates', async () => {
		await addTenant('t-race', { webhookEndpointLimit: 2 });
		const results = await Promise.all(
			[1, 2, 3, 4, 5].map((index) =>
				createWebhookEndpoint(routing(), {
					id: `race-${index}`,
					tenantId: 't-race',
					url: 'https://hooks.example.com/race',
					events: ['link.created'],
					milestoneInterval: null,
					keyId: 'key-1',
					now: clock
				})
			)
		);
		expect(results.filter((result) => result.status === 'created')).toHaveLength(2);
		expect(results.filter((result) => result.status === 'limit')).toEqual([
			{ status: 'limit', limit: 2 },
			{ status: 'limit', limit: 2 },
			{ status: 'limit', limit: 2 }
		]);
		expect(await count(routing(), 'webhook_endpoints WHERE tenant_id = ?', 't-race')).toBe(2);
		const missing = await createWebhookEndpoint(routing(), {
			id: 'race-none',
			tenantId: 't-unknown',
			url: 'https://hooks.example.com/race',
			events: ['link.created'],
			milestoneInterval: null,
			keyId: 'key-1',
			now: clock
		});
		expect(missing).toEqual({ status: 'no_workspace' });
	});

	it('updates, rotates, and deletes only the tenant endpoint', async () => {
		await addTenant('t-crud');
		await addTenant('t-other');
		const endpoint = await addEndpoint('t-crud', {
			events: ['link.created'],
			milestoneInterval: null
		});
		const milestones = await updateWebhookEndpoint(routing(), 't-crud', endpoint.id, {
			events: ['link.created', 'link.click_milestone'],
			now: clock + 1
		});
		expect(milestones?.milestoneInterval).toBe(1000);
		const interval = await updateWebhookEndpoint(routing(), 't-crud', endpoint.id, {
			milestoneInterval: 500,
			now: clock + 2
		});
		expect(interval?.milestoneInterval).toBe(500);
		const dropped = await updateWebhookEndpoint(routing(), 't-crud', endpoint.id, {
			events: ['link.updated'],
			milestoneInterval: 200,
			now: clock + 3
		});
		expect(dropped).toMatchObject({ events: ['link.updated'], milestoneInterval: null });
		expect(
			await updateWebhookEndpoint(routing(), 't-other', endpoint.id, { enabled: false, now: 1 })
		).toBeNull();

		const rotated = await rotateWebhookSecret(routing(), 't-crud', endpoint.id, {
			keyId: 'key-1',
			now: clock,
			previousUntil: clock + 86400000
		});
		expect(rotated).toMatchObject({ secretVersion: 2, previousSecretUntil: clock + 86400000 });
		// A secret from another deployment key cannot be derived any more, so it gets no grace.
		const rekeyed = await rotateWebhookSecret(routing(), 't-crud', endpoint.id, {
			keyId: 'key-2',
			now: clock,
			previousUntil: clock + 86400000
		});
		expect(rekeyed).toMatchObject({ secretVersion: 3, previousSecretUntil: null, keyId: 'key-2' });
		expect(
			await rotateWebhookSecret(routing(), 't-other', endpoint.id, {
				keyId: 'key-1',
				now: clock,
				previousUntil: clock
			})
		).toBeNull();

		expect(await deleteWebhookEndpoint(routing(), 't-other', endpoint.id)).toBe(false);
		expect(await deleteWebhookEndpoint(routing(), 't-crud', endpoint.id)).toBe(true);
		expect((await listWebhookEndpoints(routing(), 't-crud'))?.endpoints).toEqual([]);
	});
});

describe('fan-out and delivery', () => {
	it('stops creating and sending at limit 0 and resumes for new events', async () => {
		await addTenant('t-down');
		const endpoint = await addEndpoint('t-down');
		await create('t-down', 'down-1');
		expect(
			await fanOutWebhookEvents(routing(), { now: clock, limit: 50, tenantId: 't-down' })
		).toEqual({
			events: 1,
			deliveries: 1,
			skipped: 0
		});
		await create('t-down', 'down-2');
		await setWebhookLimit('t-down', 0, 2);
		const refused = await createWebhookEndpoint(routing(), {
			id: 'down-refused',
			tenantId: 't-down',
			url: 'https://hooks.example.com/in',
			events: ['link.created'],
			milestoneInterval: null,
			keyId: 'key-1',
			now: clock
		});
		expect(refused).toEqual({ status: 'limit', limit: 0 });
		const listed = await listWebhookEndpoints(routing(), 't-down');
		expect(listed).toMatchObject({ used: 1, limit: 0 });
		expect(listed?.endpoints.map((item) => item.id)).toEqual([endpoint.id]);
		expect(
			await fanOutWebhookEvents(routing(), { now: clock, limit: 50, tenantId: 't-down' })
		).toEqual({
			events: 1,
			deliveries: 0,
			skipped: 1
		});
		expect(await listEndpointDeliveries(routing(), 't-down', endpoint.id)).toMatchObject([
			{ state: 'skipped', errorCode: 'plan', completedAt: clock }
		]);
		expect(
			await claimWebhookDeliveries(routing(), { now: clock, limit: 10, tenantId: 't-down' })
		).toEqual([]);

		await setWebhookLimit('t-down', 5, 3);
		const resumed = await create('t-down', 'down-3');
		expect(resumed.eventStaged).toBe(true);
		expect(
			await fanOutWebhookEvents(routing(), { now: clock + 1, limit: 50, tenantId: 't-down' })
		).toEqual({ events: 1, deliveries: 1, skipped: 0 });
	});

	it('delivers each event once to each matching endpoint of its own workspace', async () => {
		await addTenant('t-fan-a');
		await addTenant('t-fan-b');
		const allA = await addEndpoint('t-fan-a');
		const updatesOnly = await addEndpoint('t-fan-a', { events: ['link.updated'] });
		const allB = await addEndpoint('t-fan-b');
		await create('t-fan-a', 'fan-a');
		await create('t-fan-b', 'fan-b');
		// An endpoint added after the event does not receive it.
		const late = await addEndpoint('t-fan-a', { now: clock + 1 });
		await fanOutWebhookEvents(routing(), { now: clock + 2, limit: 100 });
		expect(
			await count(
				routing(),
				'webhook_deliveries d JOIN webhook_endpoints w ON w.id = d.endpoint_id WHERE d.tenant_id <> w.tenant_id'
			)
		).toBe(0);
		const deliveries = async (endpointId: string) =>
			(await listEndpointDeliveries(routing(), 't-fan-a', endpointId)).length;
		expect(await deliveries(allA.id)).toBe(1);
		expect(await deliveries(updatesOnly.id)).toBe(0);
		expect(await deliveries(late.id)).toBe(0);
		expect((await listEndpointDeliveries(routing(), 't-fan-b', allB.id)).length).toBe(1);

		// A repeated fan-out of the same events adds no delivery.
		await routing()
			.prepare(
				"UPDATE webhook_events SET fanned_out_at = NULL WHERE tenant_id IN ('t-fan-a', 't-fan-b')"
			)
			.run();
		const again = await fanOutWebhookEvents(routing(), { now: clock + 3, limit: 100 });
		expect(again).toMatchObject({ events: 2, deliveries: 0 });

		// A test event goes only to its target, even when the target is off.
		await updateWebhookEndpoint(routing(), 't-fan-a', updatesOnly.id, {
			enabled: false,
			now: clock
		});
		expect(
			await insertTestEvent(routing(), {
				id: 'evt-test-1',
				tenantId: 't-fan-a',
				endpointId: updatesOnly.id,
				payload: JSON.stringify({ message: 'Test event from Flared.' }),
				now: clock + 4
			})
		).toBe(true);
		expect(
			await insertTestEvent(routing(), {
				id: 'evt-test-2',
				tenantId: 't-fan-b',
				endpointId: updatesOnly.id,
				payload: '{}',
				now: clock + 4
			})
		).toBe(false);
		await fanOutWebhookEvents(routing(), { now: clock + 5, limit: 100, tenantId: 't-fan-a' });
		expect(await listEndpointDeliveries(routing(), 't-fan-a', updatesOnly.id)).toMatchObject([
			{ eventId: 'evt-test-1', eventType: 'webhook.test', state: 'pending' }
		]);
		expect(await deliveries(allA.id)).toBe(1);
	});

	it('claims disjoint deliveries in concurrent runs and backs off each attempt', async () => {
		await addTenant('t-claim');
		const endpoint = await addEndpoint('t-claim');
		for (const index of [1, 2, 3, 4, 5, 6]) await create('t-claim', `claim-${index}`);
		await fanOutWebhookEvents(routing(), { now: clock, limit: 50, tenantId: 't-claim' });
		const options = { now: clock, limit: 4, tenantId: 't-claim', untriedOnly: true };
		const [first, second] = await Promise.all([
			claimWebhookDeliveries(routing(), options),
			claimWebhookDeliveries(routing(), options)
		]);
		expect(first.length + second.length).toBe(6);
		expect(new Set([...first, ...second]).size).toBe(6);
		expect(await claimWebhookDeliveries(routing(), { now: clock, limit: 10 })).toEqual([]);
		const claimed = await readClaimedDeliveries(routing(), first);
		expect(claimed).toHaveLength(first.length);
		expect(claimed[0]).toMatchObject({
			tenantId: 't-claim',
			attempts: 1,
			event: { type: 'link.created', targeted: false },
			endpoint: { id: endpoint.id, url: 'https://hooks.example.com/in', enabled: true }
		});
		const due = await routing()
			.prepare(
				"SELECT DISTINCT next_attempt_at AS due FROM webhook_deliveries WHERE tenant_id = 't-claim'"
			)
			.all<{ due: number }>();
		expect(due.results).toEqual([{ due: clock + minute }]);
		// A run that never finished leaves its claims for a later run.
		expect(
			await claimWebhookDeliveries(routing(), {
				now: clock + minute,
				limit: 10,
				tenantId: 't-claim'
			})
		).toHaveLength(6);
		expect(
			await claimWebhookDeliveries(routing(), {
				now: clock + minute,
				limit: 10,
				tenantId: 't-claim',
				untriedOnly: true
			})
		).toEqual([]);
	});

	it('records results, pauses a failing endpoint, and fails after the last attempt', async () => {
		await addTenant('t-finish');
		const endpoint = await addEndpoint('t-finish');
		await create('t-finish', 'finish-1');
		await create('t-finish', 'finish-2');
		await fanOutWebhookEvents(routing(), { now: clock, limit: 50, tenantId: 't-finish' });
		const [first] = await claimWebhookDeliveries(routing(), {
			now: clock,
			limit: 1,
			tenantId: 't-finish'
		});
		await finishWebhookDeliveries(
			routing(),
			[
				{
					id: first,
					endpointId: endpoint.id,
					outcome: 'retry',
					responseStatus: 500,
					errorCode: 'http_status',
					durationMs: 12
				}
			],
			clock
		);
		const [paused] = (await listWebhookEndpoints(routing(), 't-finish'))?.endpoints ?? [];
		expect(paused).toMatchObject({
			failureCount: 1,
			pausedUntil: clock + minute,
			lastFailureAt: clock
		});
		// The other delivery waits for the pause.
		expect(
			await claimWebhookDeliveries(routing(), { now: clock + 1, limit: 10, tenantId: 't-finish' })
		).toEqual([]);
		const both = await claimWebhookDeliveries(routing(), {
			now: clock + minute,
			limit: 10,
			tenantId: 't-finish'
		});
		expect(both).toHaveLength(2);
		await finishWebhookDeliveries(
			routing(),
			both.map((id) => ({
				id,
				endpointId: endpoint.id,
				outcome: 'succeeded' as const,
				responseStatus: 204,
				errorCode: null,
				durationMs: 8
			})),
			clock + minute
		);
		const [healthy] = (await listWebhookEndpoints(routing(), 't-finish'))?.endpoints ?? [];
		expect(healthy).toMatchObject({
			failureCount: 0,
			pausedUntil: null,
			lastSuccessAt: clock + minute
		});
		const history = await listEndpointDeliveries(routing(), 't-finish', endpoint.id);
		expect(history.map((item) => [item.state, item.responseStatus])).toEqual([
			['succeeded', 204],
			['succeeded', 204]
		]);

		await create('t-finish', 'finish-3');
		await fanOutWebhookEvents(routing(), { now: clock, limit: 50, tenantId: 't-finish' });
		const [last] = await claimWebhookDeliveries(routing(), {
			now: clock + minute,
			limit: 1,
			tenantId: 't-finish'
		});
		await routing()
			.prepare('UPDATE webhook_deliveries SET attempts = 10 WHERE id = ?')
			.bind(last)
			.run();
		await finishWebhookDeliveries(
			routing(),
			[
				{
					id: last,
					endpointId: endpoint.id,
					outcome: 'retry',
					responseStatus: null,
					errorCode: 'timeout',
					durationMs: 10000
				}
			],
			clock + 2 * minute
		);
		const failed = (await listEndpointDeliveries(routing(), 't-finish', endpoint.id)).find(
			(delivery) => delivery.id === last
		);
		expect(failed).toMatchObject({
			state: 'failed',
			errorCode: 'timeout',
			completedAt: clock + 2 * minute
		});
	});

	it('expires deliveries pending past 72 hours and removes records past 30 days', async () => {
		await addTenant('t-old');
		const endpoint = await addEndpoint('t-old', { now: 0 });
		const insert = (id: string, createdAt: number, state = 'pending') =>
			routing().batch([
				routing()
					.prepare(
						"INSERT INTO webhook_events (id, tenant_id, type, payload, created_at, fanned_out_at) VALUES (?, 't-old', 'link.created', '{}', ?, ?)"
					)
					.bind(`evt-${id}`, createdAt, createdAt),
				routing()
					.prepare(
						"INSERT INTO webhook_deliveries (id, tenant_id, event_id, endpoint_id, state, next_attempt_at, created_at) VALUES (?, 't-old', ?, ?, ?, ?, ?)"
					)
					.bind(`dlv-${id}`, `evt-${id}`, endpoint.id, state, createdAt, createdAt)
			]);
		await insert('expired', clock - webhookDeliveryLifetimeMs - 1);
		await insert('young', clock - 60 * minute);
		await insert('ancient', clock - webhookRecordLifetimeMs - 1, 'succeeded');
		expect(await expireWebhookDeliveries(routing(), clock, 100)).toBe(1);
		const state = async (id: string) =>
			routing()
				.prepare('SELECT state, error_code FROM webhook_deliveries WHERE id = ?')
				.bind(id)
				.first();
		expect(await state('dlv-expired')).toEqual({ state: 'failed', error_code: 'expired' });
		expect(await state('dlv-young')).toEqual({ state: 'pending', error_code: null });
		expect(await deleteOldWebhookRecords(routing(), clock, 100)).toBe(2);
		expect(await state('dlv-ancient')).toBeNull();
		expect(await count(routing(), "webhook_events WHERE id = 'evt-ancient'")).toBe(0);
		expect(await count(routing(), "webhook_deliveries WHERE tenant_id = 't-old'")).toBe(2);
		expect(await deleteOldWebhookRecords(routing(), clock, 100)).toBe(0);
	});
});

describe('click milestones', () => {
	it('moves milestones to the subscribed workspaces once and drops the rest', async () => {
		await addTenant('t-mile');
		await addTenant('t-mile-none');
		const every500 = await addEndpoint('t-mile', {
			events: ['link.click_milestone'],
			milestoneInterval: 500
		});
		const every100 = await addEndpoint('t-mile');
		await addEndpoint('t-mile-none', { events: ['link.created'], milestoneInterval: null });
		const linkId = await createdLinkId(await create('t-mile', 'mile-1'));
		const otherId = await createdLinkId(await create('t-mile-none', 'mile-none-1'));
		await fanOutWebhookEvents(routing(), { now: clock, limit: 50 });
		const rows = [
			...Array.from({ length: 10 }, (_, index) => ['t-mile', linkId, (index + 1) * 100] as const),
			['t-mile-none', otherId, 100] as const
		];
		await shard().batch(
			rows.map(([tenantId, link, clicks]) =>
				shard()
					.prepare(
						'INSERT INTO click_milestones (id, tenant_id, link_id, clicks, created_at) VALUES (?, ?, ?, ?, ?)'
					)
					.bind(`link.click_milestone:${link}:${clicks}`, tenantId, link, clicks, clock + 10)
			)
		);
		const milestones = await readClickMilestones(shard(), 50);
		expect(milestones).toHaveLength(11);
		expect(await insertMilestoneEvents(routing(), milestones)).toBe(10);
		// A run that stopped before deleting writes nothing twice.
		expect(await insertMilestoneEvents(routing(), milestones)).toBe(0);
		expect(
			await deleteClickMilestones(
				shard(),
				milestones.map((milestone) => milestone.id)
			)
		).toBe(11);
		expect(await events('t-mile-none')).toHaveLength(1);
		const [newest] = await events('t-mile');
		expect(newest).toMatchObject({ type: 'link.click_milestone', subjectId: linkId });
		const payload = JSON.parse(newest.payload);
		expect(payload.link).toEqual(JSON.parse(await apiLinkText('t-mile', linkId)));

		await fanOutWebhookEvents(routing(), { now: clock + 20, limit: 50, tenantId: 't-mile' });
		const received = async (endpointId: string) =>
			(await listEndpointDeliveries(routing(), 't-mile', endpointId))
				.filter((delivery) => delivery.eventType === 'link.click_milestone')
				.map((delivery) => Number(delivery.eventId.split(':')[2]))
				.sort((a, b) => a - b);
		expect(await received(every500.id)).toEqual([500, 1000]);
		expect(await received(every100.id)).toEqual([
			100, 200, 300, 400, 500, 600, 700, 800, 900, 1000
		]);
	});
});

describe('statement budget', () => {
	it('adds one statement to a create, four to an edit, and keeps delivery runs small', async () => {
		await addTenant('t-budget');
		const counter = { queries: 0 };
		const counted = counting(routing(), counter);
		const created = await createLink(counted, {
			tenantId: 't-budget',
			key: 'budget-1',
			input: {
				destination: 'https://example.com/budget',
				slug: null,
				title: null,
				domainId: null,
				iosDestination: null,
				androidDestination: null
			},
			requestId: 'request-1',
			now: clock
		});
		// The domain lookup and the 9-statement batch; no endpoint, so nothing is staged.
		expect([counter.queries, created.eventStaged]).toEqual([10, false]);
		const linkId = await createdLinkId(created);
		counter.queries = 0;
		await updateLink(counted, 't-budget', linkId, change({ title: 'Budget' }));
		expect(counter.queries).toBe(4);
		const measure = async (run: () => Promise<unknown>) => {
			counter.queries = 0;
			await run();
			return counter.queries;
		};
		expect(await measure(() => fanOutWebhookEvents(counted, { now: clock, limit: 50 }))).toBe(3);
		expect(await measure(() => claimWebhookDeliveries(counted, { now: clock, limit: 5 }))).toBe(1);
	});
});

describe('contracts', () => {
	it('accepts only public https endpoint URLs', () => {
		const reserved = ['flared.example', 'short.example'];
		expect(parseWebhookUrl('https://hooks.acme.com/in?x=1', reserved)).toBe(
			'https://hooks.acme.com/in?x=1'
		);
		expect(parseWebhookUrl('https://Hooks.Acme.com:443/in', reserved)).toBe(
			'https://hooks.acme.com/in'
		);
		for (const url of [
			'http://hooks.acme.com/in',
			'https://127.0.0.1/in',
			'https://[::1]/in',
			'https://2130706433/in',
			'https://intranet/in',
			'https://printer.local/in',
			'https://db.internal/in',
			'https://localhost/in',
			'https://u:p@h.com/in',
			'https://h.com:8443/in',
			'https://flared.example/in',
			'https://api.flared.example/in',
			`https://hooks.acme.com/${'a'.repeat(2048)}`,
			'',
			42
		])
			expect(() => parseWebhookUrl(url, reserved), String(url)).toThrow();
	});

	it('checks events and milestone intervals', () => {
		expect(
			parseCreateWebhook(
				{ url: 'https://hooks.acme.com/in', events: ['link.click_milestone', 'link.created'] },
				[]
			)
		).toEqual({
			url: 'https://hooks.acme.com/in',
			events: ['link.created', 'link.click_milestone'],
			milestoneInterval: 1000
		});
		expect(
			parseCreateWebhook(
				{ url: 'https://hooks.acme.com/in', events: ['link.created'], milestoneInterval: 500 },
				[]
			).milestoneInterval
		).toBeNull();
		for (const milestoneInterval of [0, 50, 150, 1_000_100, 100.5, '100'])
			expect(() =>
				parseCreateWebhook(
					{ url: 'https://hooks.acme.com/in', events: ['link.click_milestone'], milestoneInterval },
					[]
				)
			).toThrow();
		for (const events of [[], ['webhook.test'], ['link.deleted'], 'link.created'])
			expect(() => parseCreateWebhook({ url: 'https://hooks.acme.com/in', events }, [])).toThrow();
		expect(parseUpdateWebhook({ enabled: false, milestoneInterval: 1_000_000 }, [])).toEqual({
			enabled: false,
			milestoneInterval: 1_000_000
		});
		expect(() => parseUpdateWebhook({}, [])).toThrow();
		expect(() => parseUpdateWebhook({ secret: 'x' }, [])).toThrow();
	});
});
