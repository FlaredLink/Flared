// SPDX-License-Identifier: AGPL-3.0-only
// Destination checks for "destination stops loading" templates against real D1: how answers
// count, two failures in a row, a changed destination, one request for a shared destination,
// the body limit, logs without URLs, the hostname rules at each hop and at apply, the 6-hour
// spacing, templates that are off, workspaces at limit 0, and the D1 statements of a run.
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
	ApplyAutomationLinksResult,
	Automation,
	LinkAutomationPage
} from '../packages/contracts/src/automations';
import { readLink } from '../packages/data/src/links';
import { createTenant } from '../packages/data/src/tenancy';
import { createApi, type ApiPrincipal } from '../packages/server/src/api';
import {
	checkDestinations,
	destinationCheckKey,
	type DestinationCheckSettings
} from '../packages/server/src/automations/checks';
import { runAutomationJob } from '../packages/server/src/automations/jobs';
import { createLink } from '../packages/server/src/links';
import { projectPolicy, updatePolicy } from '../packages/server/src/tenancy';
import { counting } from './support/d1-count';

const origin = 'https://app.checks.net';
const platformHost = 'go.checks.net';
const workspaceHost = 'links.brand.com';
const reserved = [platformHost, 'app.checks.net'];
const identity = () => env.CHECKS_IDENTITY;
const routing = () => env.CHECKS_ROUTING;
const shards = () => ({ 'analytics-1': env.CHECKS_ANALYTICS });
const policyStores = () => ({ routing: routing(), analytics: shards() });
const hour = 3600000;
const start = Date.UTC(2026, 9, 18, 9, 30, 0);
let clock = start;
const baseLimits = {
	activeLinkLimit: 500,
	monthlyClickLimit: 5000,
	retentionDays: 30,
	domainLimit: 5,
	webhookEndpointLimit: 5,
	automationLimit: 25
};
const tenantOf: Record<string, string> = {};

type Answer = () => Response | Promise<Response>;
let routes = new Map<string, Answer>();
let requested: { url: string; init: RequestInit }[] = [];
const fetcher: typeof fetch = async (input, init = {}) => {
	const url = input instanceof Request ? input.url : String(input);
	requested.push({ url, init });
	const answer = routes.get(url);
	if (!answer) throw new TypeError('No route in this test');
	return answer();
};

const status =
	(code: number, headers: Record<string, string> = {}): Answer =>
	() =>
		new Response(code === 204 || code === 304 ? null : 'page', { status: code, headers });
const redirect =
	(location: string, code = 302): Answer =>
	() =>
		new Response(null, { status: code, headers: { location } });

function settings(change: Partial<DestinationCheckSettings> = {}): DestinationCheckSettings {
	return {
		limit: 100,
		concurrency: 5,
		userAgent: 'Flared-LinkCheck/1.0 (+https://docs.example.org/automations)',
		reservedHostnames: reserved,
		fetch: fetcher,
		...change
	};
}

const check = (db: D1Database = routing()) =>
	checkDestinations({ routing: db }, { ...settings(), now: clock });

const job = () =>
	runAutomationJob(
		{ identity: identity(), routing: routing(), analytics: shards() },
		{ email: false, now: () => clock, checks: settings() }
	);

afterEach(async () => {
	routes = new Map();
	requested = [];
	clock = start;
	vi.restoreAllMocks();
	// Each test starts with no application to check.
	await routing().batch([
		routing().prepare('DELETE FROM link_automations'),
		routing().prepare('DELETE FROM automation_runs')
	]);
});

async function addTenant(userId: string, tenantId: string): Promise<void> {
	tenantOf[userId] = tenantId;
	await identity()
		.prepare(
			'INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 0, 0)'
		)
		.bind(userId, '', `${userId}@example.com`)
		.run();
	await createTenant(identity(), {
		id: tenantId,
		name: 'Workspace',
		ownerUserId: userId,
		analyticsShardId: 'analytics-1',
		limits: baseLimits,
		now: 1
	});
	await projectPolicy(identity(), policyStores(), tenantId, 1);
}

function api() {
	return createApi({
		identity: identity(),
		routing: routing(),
		analytics: shards(),
		appOrigin: origin,
		domains: { reservedHostnames: [platformHost] },
		now: () => clock,
		automations: { email: false, destinationChecks: true },
		authenticate: async (request): Promise<ApiPrincipal | null> => {
			const userId = request.headers.get('x-test-user');
			if (!userId) return null;
			return {
				kind: 'session',
				userId,
				sessionId: `session-${userId}`,
				signedInAt: new Date(clock).toISOString()
			};
		}
	});
}

async function call(
	userId: string,
	method: string,
	path: string,
	body?: unknown
): Promise<{ status: number; text: string; json: unknown }> {
	const headers: Record<string, string> = { 'x-test-user': userId, origin };
	const init: RequestInit = { method, headers };
	if (body !== undefined) {
		init.body = JSON.stringify(body);
		headers['content-type'] = 'application/json';
	}
	const response = await api().fetch(new Request(`${origin}/v1${path}`, init));
	const text = await response.text();
	return { status: response.status, text, json: text ? JSON.parse(text) : null };
}

async function template(userId: string, actions: unknown[] = [{ type: 'disable_link' }]) {
	const created = await call(userId, 'POST', '/automations', {
		name: 'Destination down',
		trigger: { type: 'destination_down' },
		actions
	});
	expect(created.status, created.text).toBe(201);
	return (created.json as { automation: Automation }).automation;
}

let linkCounter = 0;
async function addLink(tenantId: string, destination: string): Promise<string> {
	linkCounter += 1;
	const result = await createLink(routing(), {
		tenantId,
		key: `check-link-${linkCounter}`,
		input: {
			destination,
			slug: null,
			title: null,
			domainId: null,
			iosDestination: null,
			androidDestination: null,
			startsAt: null,
			endsAt: null,
			endedDestination: null,
			password: null,
			previewTitle: null,
			previewDescription: null
		},
		requestId: 'request-1',
		now: clock
	});
	expect(result.status, result.body).toBe(201);
	return (JSON.parse(result.body) as { link: { id: string } }).link.id;
}

async function apply(userId: string, linkId: string, automationId: string): Promise<void> {
	const result = await call(userId, 'PUT', `/links/${linkId}/automations/${automationId}`);
	expect(result.status, result.text).toBe(200);
}

// A link with the template applied, then given a destination that the API would refuse.
async function linkWith(userId: string, automationId: string, destination: string) {
	const linkId = await addLink(tenantOf[userId], 'https://placeholder.example.org/');
	await apply(userId, linkId, automationId);
	await routing()
		.prepare('UPDATE links SET destination = ? WHERE id = ?')
		.bind(destination, linkId)
		.run();
	return linkId;
}

interface CheckRow {
	state: string;
	due_at: number | null;
	check_key: string | null;
	check_failures: number;
	last_checked_at: number | null;
	last_check_result: string | null;
	result_code: string | null;
}

async function row(linkId: string, automationId: string): Promise<CheckRow | null> {
	return routing()
		.prepare(
			'SELECT state, due_at, check_key, check_failures, last_checked_at, last_check_result, result_code FROM link_automations WHERE link_id = ? AND automation_id = ?'
		)
		.bind(linkId, automationId)
		.first<CheckRow>();
}

beforeAll(async () => {
	await applyD1Migrations(identity(), env.IDENTITY_MIGRATIONS, 'flared_core_migrations');
	await applyD1Migrations(routing(), env.ROUTING_MIGRATIONS, 'flared_core_migrations');
	await applyD1Migrations(env.CHECKS_ANALYTICS, env.ANALYTICS_MIGRATIONS, 'flared_core_migrations');
	await identity()
		.prepare("INSERT INTO installation (id, mode, created_at) VALUES (1, 'multi', 0)")
		.run();
	await addTenant('u-check', 't-check');
	await routing().batch([
		routing()
			.prepare(
				"INSERT INTO domain_namespaces (id, hostname, created_at) VALUES ('dom-platform', ?, 0)"
			)
			.bind(platformHost),
		routing().prepare(
			"INSERT INTO domains (id, tenant_id, state, is_default, created_at, updated_at) VALUES ('dom-platform', NULL, 'active', 1, 0, 0)"
		),
		// A workspace's own domain, not one of the installation's hostnames.
		routing()
			.prepare(
				"INSERT INTO domain_namespaces (id, hostname, created_at) VALUES ('dom-brand', ?, 0)"
			)
			.bind(workspaceHost),
		routing().prepare(
			"INSERT INTO domains (id, tenant_id, state, is_default, created_at, updated_at) VALUES ('dom-brand', 't-check', 'active', 0, 0, 0)"
		)
	]);
});

describe('destination checks', () => {
	it('counts no answer, a timeout, 404, 410, and 5xx as failures, and other answers as up', async () => {
		const automation = await template('u-check');
		const cases: [string, Answer, boolean, string][] = [
			['https://s404.example.org/', status(404), true, '404'],
			['https://s410.example.org/', status(410), true, '410'],
			['https://s500.example.org/', status(500), true, '500'],
			['https://s502.example.org/', status(502), true, '502'],
			['https://s503.example.org/', status(503), true, '503'],
			[
				'https://timeout.example.org/',
				() => Promise.reject(new DOMException('The operation timed out.', 'TimeoutError')),
				true,
				'timeout'
			],
			[
				'https://network.example.org/',
				() => Promise.reject(new TypeError('Network connection lost.')),
				true,
				'network'
			],
			['https://s200.example.org/', status(200), false, '200'],
			['https://s204.example.org/', status(204), false, '204'],
			['https://s401.example.org/', status(401), false, '401'],
			['https://s403.example.org/', status(403), false, '403'],
			['https://s429.example.org/', status(429), false, '429'],
			['https://s418.example.org/', status(418), false, '418'],
			[
				'https://challenge.example.org/',
				status(503, { 'cf-mitigated': 'challenge' }),
				false,
				'503'
			],
			['https://empty-redirect.example.org/', status(302), false, '302']
		];
		const linkIds: string[] = [];
		for (const [destination, answer] of cases) {
			routes.set(destination, answer);
			const linkId = await addLink('t-check', destination);
			await apply('u-check', linkId, automation.id);
			linkIds.push(linkId);
		}
		// Three redirects: the third request ends the check as up.
		routes.set('https://loop.example.org/', redirect('/a', 301));
		routes.set('https://loop.example.org/a', redirect('https://loop2.example.org/b', 302));
		routes.set('https://loop2.example.org/b', redirect('/c', 307));
		const loop = await addLink('t-check', 'https://loop.example.org/');
		await apply('u-check', loop, automation.id);

		const summary = await check();
		expect(summary).toEqual({
			claimed: cases.length + 1,
			destinations: cases.length + 1,
			requests: cases.length + 3,
			failed: 7,
			notCheckable: 0
		});
		for (const [index, [destination, , failed, result]] of cases.entries())
			expect(await row(linkIds[index], automation.id), destination).toMatchObject({
				state: 'waiting',
				due_at: null,
				check_key: await destinationCheckKey(destination),
				check_failures: failed ? 1 : 0,
				last_checked_at: clock,
				last_check_result: result,
				result_code: null
			});
		expect(await row(loop, automation.id)).toMatchObject({
			check_failures: 0,
			last_check_result: '307'
		});
		expect(requested.filter((item) => item.url.includes('loop')).map((item) => item.url)).toEqual([
			'https://loop.example.org/',
			'https://loop.example.org/a',
			'https://loop2.example.org/b'
		]);
		for (const { init } of requested) {
			expect(init.method).toBe('GET');
			expect(init.redirect).toBe('manual');
			expect(new Headers(init.headers).get('user-agent')).toBe(settings().userAgent);
			expect(init.signal).toBeInstanceOf(AbortSignal);
		}
	});

	it('runs the automation in the same job after the second failure in a row', async () => {
		const automation = await template('u-check');
		const destination = 'https://down.example.org/shop';
		routes.set(destination, status(404));
		const linkId = await addLink('t-check', destination);
		await apply('u-check', linkId, automation.id);

		const first = await job();
		expect(first.checks).toMatchObject({ claimed: 1, failed: 1 });
		expect(first).toMatchObject({ claimed: 0, ran: 0 });
		expect(await row(linkId, automation.id)).toMatchObject({
			state: 'waiting',
			check_failures: 1,
			due_at: null
		});

		clock += 6 * hour;
		const second = await job();
		expect(second.checks).toMatchObject({ claimed: 1, failed: 1 });
		expect(second).toMatchObject({ claimed: 1, ran: 1 });
		expect(await row(linkId, automation.id)).toMatchObject({
			state: 'done',
			check_failures: 2,
			due_at: clock
		});
		expect((await readLink(routing(), 't-check', linkId))?.active).toBe(false);
		expect(requested).toHaveLength(2);
		// A done application is not checked again.
		clock += 6 * hour;
		expect((await job()).checks).toMatchObject({ claimed: 0 });
	});

	it('starts the count again when the destination changes between failures', async () => {
		const automation = await template('u-check');
		const first = 'https://first.example.org/';
		const second = 'https://second.example.org/';
		routes.set(first, status(500));
		routes.set(second, status(500));
		const linkId = await addLink('t-check', first);
		await apply('u-check', linkId, automation.id);
		await check();
		expect(await row(linkId, automation.id)).toMatchObject({ check_failures: 1 });

		const changed = await call('u-check', 'PATCH', `/links/${linkId}`, { destination: second });
		expect(changed.status, changed.text).toBe(200);
		clock += 6 * hour;
		await check();
		expect(await row(linkId, automation.id)).toMatchObject({
			check_failures: 1,
			check_key: await destinationCheckKey(second),
			due_at: null
		});

		clock += 6 * hour;
		await check();
		expect(await row(linkId, automation.id)).toMatchObject({ check_failures: 2, due_at: clock });
	});

	it('clears the count when a check passes', async () => {
		const automation = await template('u-check');
		const destination = 'https://flaky.example.org/';
		routes.set(destination, status(502));
		const linkId = await addLink('t-check', destination);
		await apply('u-check', linkId, automation.id);
		await check();
		routes.set(destination, status(200));
		clock += 6 * hour;
		await check();
		routes.set(destination, status(502));
		clock += 6 * hour;
		await check();
		expect(await row(linkId, automation.id)).toMatchObject({ check_failures: 1, due_at: null });
	});

	it('requests a destination once for three applications that share it', async () => {
		const automation = await template('u-check');
		const other = await template('u-check', [{ type: 'disable_link' }]);
		const destination = 'https://shared.example.org/';
		routes.set(destination, status(500));
		const first = await addLink('t-check', destination);
		const second = await addLink('t-check', destination);
		await apply('u-check', first, automation.id);
		await apply('u-check', second, automation.id);
		await apply('u-check', first, other.id);

		const summary = await check();
		expect(summary).toMatchObject({ claimed: 3, destinations: 1, requests: 1, failed: 3 });
		expect(requested).toHaveLength(1);
		const key = await destinationCheckKey(destination);
		for (const [linkId, automationId] of [
			[first, automation.id],
			[second, automation.id],
			[first, other.id]
		])
			expect(await row(linkId, automationId)).toMatchObject({
				check_key: key,
				check_failures: 1
			});
	});

	it('reads at most 1 KB of a page and cancels the rest', async () => {
		const automation = await template('u-check');
		const destination = 'https://large.example.org/';
		let pulled = 0;
		let cancelled = false;
		routes.set(
			destination,
			() =>
				new Response(
					new ReadableStream<Uint8Array>(
						{
							pull(controller) {
								if (pulled >= 1_000_000) return controller.close();
								pulled += 512;
								controller.enqueue(new Uint8Array(512));
							},
							cancel() {
								cancelled = true;
							}
						},
						{ highWaterMark: 0 }
					),
					{ status: 200 }
				)
		);
		const linkId = await addLink('t-check', destination);
		await apply('u-check', linkId, automation.id);
		await check();
		expect(await row(linkId, automation.id)).toMatchObject({ last_check_result: '200' });
		expect(cancelled).toBe(true);
		expect(pulled).toBeLessThanOrEqual(1024);
	});

	it('logs IDs and result codes, never a URL', async () => {
		const lines: string[] = [];
		for (const method of ['log', 'error', 'warn', 'info', 'debug'] as const)
			vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
				lines.push(args.map(String).join(' '));
			});
		const automation = await template('u-check');
		const failing = 'https://secret-shop.example.org/private?token=hidden-value';
		const up = 'https://secret-blog.example.org/post?token=hidden-value';
		routes.set(failing, status(404));
		routes.set(up, redirect('https://secret-next.example.org/?token=hidden-value'));
		routes.set('https://secret-next.example.org/?token=hidden-value', status(200));
		const failingLink = await addLink('t-check', failing);
		const upLink = await addLink('t-check', up);
		await apply('u-check', failingLink, automation.id);
		await apply('u-check', upLink, automation.id);
		const hidden = await linkWith('u-check', automation.id, 'http://10.0.0.7/secret-path');
		await check();
		const output = lines.join('\n');
		expect(output).toContain('destination_checks');
		expect(output).toContain(failingLink);
		expect(output).toContain(hidden);
		for (const part of ['http', 'secret', 'hidden-value', '10.0.0.7', 'example.org'])
			expect(output).not.toContain(part);
	});

	it('requests no destination off the public web, of the installation, or of an active domain', async () => {
		const automation = await template('u-check');
		const destinations = [
			'http://10.0.0.1/',
			'http://127.0.0.1:8080/',
			'http://[::1]/',
			'http://intranet/',
			'https://printer.local/',
			'https://ports.example.org:8443/',
			'http://ports.example.org:443/',
			`https://${platformHost}/sale`,
			`https://deep.${platformHost}/`,
			'https://app.checks.net/app',
			`https://${workspaceHost}/sale`
		];
		const linkIds: string[] = [];
		for (const destination of destinations)
			linkIds.push(await linkWith('u-check', automation.id, destination));

		const summary = await check();
		expect(summary).toMatchObject({
			claimed: destinations.length,
			requests: 0,
			failed: 0,
			notCheckable: destinations.length
		});
		expect(requested).toEqual([]);
		for (const [index, linkId] of linkIds.entries())
			expect(await row(linkId, automation.id), destinations[index]).toMatchObject({
				state: 'waiting',
				due_at: null,
				check_failures: 0,
				last_check_result: 'not_checkable',
				result_code: 'not_checkable'
			});
		const listed = await call('u-check', 'GET', `/links/${linkIds[0]}/automations`);
		expect((listed.json as LinkAutomationPage).automations[0]).toMatchObject({
			state: 'waiting',
			result: 'not_checkable',
			check: { lastCheckedAt: new Date(clock).toISOString(), lastResult: 'not_checkable' }
		});
		// A later check that can request the destination clears the result.
		await routing()
			.prepare('UPDATE links SET destination = ? WHERE id = ?')
			.bind('https://fixed.example.org/', linkIds[0])
			.run();
		routes.set('https://fixed.example.org/', status(200));
		clock += 6 * hour;
		await check();
		expect(await row(linkIds[0], automation.id)).toMatchObject({
			last_check_result: '200',
			result_code: null
		});
	});

	it('stops at the hop check when a redirect leads where a check may not go', async () => {
		const automation = await template('u-check');
		const hops: [string, string][] = [
			['https://hop-ip.example.org/', 'http://127.0.0.1/admin'],
			['https://hop-flared.example.org/', `https://${platformHost}/abc`],
			['https://hop-domain.example.org/', `https://${workspaceHost}/abc`],
			['https://hop-port.example.org/', 'https://hop-port.example.org:8080/'],
			['https://hop-scheme.example.org/', 'ftp://files.example.org/']
		];
		const linkIds: string[] = [];
		for (const [destination, location] of hops) {
			routes.set(destination, redirect(location));
			const linkId = await addLink('t-check', destination);
			await apply('u-check', linkId, automation.id);
			linkIds.push(linkId);
		}
		const summary = await check();
		expect(summary).toMatchObject({ requests: hops.length, notCheckable: hops.length });
		expect(requested.map((item) => item.url)).toEqual(
			expect.arrayContaining(hops.map(([destination]) => destination))
		);
		expect(requested).toHaveLength(hops.length);
		for (const linkId of linkIds)
			expect(await row(linkId, automation.id)).toMatchObject({
				check_failures: 0,
				last_check_result: 'not_checkable'
			});
	});

	it('refuses to apply the template to a destination a check may not request', async () => {
		const automation = await template('u-check');
		const bad = await addLink('t-check', 'http://192.168.1.10/');
		const good = await addLink('t-check', 'https://good.example.org/');
		const flared = await addLink('t-check', `https://${platformHost}/other`);
		// Active domains are looked up only by the check.
		const domain = await addLink('t-check', `https://${workspaceHost}/sale`);

		const one = await call('u-check', 'PUT', `/links/${bad}/automations/${automation.id}`);
		expect(one.status).toBe(422);
		expect((one.json as { error: { code: string; field?: string } }).error).toMatchObject({
			code: 'INVALID_INPUT',
			field: 'destination'
		});
		const bulk = await call('u-check', 'POST', `/automations/${automation.id}/links`, {
			linkIds: [good, bad, 'lnk_missing', flared, domain]
		});
		expect(bulk.status, bulk.text).toBe(200);
		expect(
			(bulk.json as ApplyAutomationLinksResult).results.map((item) => [
				item.status,
				item.error?.code ?? null
			])
		).toEqual([
			['applied', null],
			['failed', 'INVALID_INPUT'],
			['failed', 'NOT_FOUND'],
			['failed', 'INVALID_INPUT'],
			['applied', null]
		]);
		expect(await row(bad, automation.id)).toBeNull();
		// Another trigger takes any destination.
		const endDate = await call('u-check', 'POST', '/automations', {
			name: 'Ends',
			trigger: { type: 'end_date' },
			actions: [{ type: 'disable_link' }]
		});
		const ends = (endDate.json as { automation: Automation }).automation;
		const other = await call('u-check', 'PUT', `/links/${bad}/automations/${ends.id}`, {
			endsAt: new Date(clock + hour).toISOString()
		});
		expect(other.status, other.text).toBe(200);
		const page = await call('u-check', 'GET', '/automations');
		expect((page.json as { triggerTypes: string[] }).triggerTypes).toContain('destination_down');
	});

	it('checks an application again after 6 hours at the earliest', async () => {
		const automation = await template('u-check');
		const destination = 'https://spaced.example.org/';
		routes.set(destination, status(200));
		const linkId = await addLink('t-check', destination);
		await apply('u-check', linkId, automation.id);
		expect(await check()).toMatchObject({ claimed: 1 });
		clock += 6 * hour - 60000;
		expect(await check()).toMatchObject({ claimed: 0, requests: 0 });
		clock += 60000;
		expect(await check()).toMatchObject({ claimed: 1, requests: 1 });
		expect(requested).toHaveLength(2);
	});

	it('checks no template that is off and no workspace at automation limit 0', async () => {
		const automation = await template('u-check');
		const destination = 'https://paused.example.org/';
		routes.set(destination, status(404));
		const linkId = await addLink('t-check', destination);
		await apply('u-check', linkId, automation.id);
		const off = await call('u-check', 'PATCH', `/automations/${automation.id}`, {
			enabled: false
		});
		expect(off.status, off.text).toBe(200);
		expect(await check()).toMatchObject({ claimed: 0 });
		await call('u-check', 'PATCH', `/automations/${automation.id}`, { enabled: true });

		await addTenant('u-zero', 't-zero');
		const theirs = await template('u-zero');
		const theirLink = await addLink('t-zero', destination);
		await apply('u-zero', theirLink, theirs.id);
		const lowered = await updatePolicy(
			identity(),
			policyStores(),
			't-zero',
			{ ...baseLimits, automationLimit: 0 },
			clock
		);
		expect(lowered.projected).toBe(true);
		const summary = await check();
		expect(summary).toMatchObject({ claimed: 1, requests: 1 });
		expect(await row(linkId, automation.id)).toMatchObject({ check_failures: 1 });
		expect(await row(theirLink, theirs.id)).toMatchObject({ last_checked_at: null });
	});

	it('runs in 5 statements at most, and 1 when nothing is due', async () => {
		const automation = await template('u-check');
		// Each destination redirects to a new host twice: 3 requests and 3 domain lookups.
		for (let index = 0; index < 3; index += 1) {
			const destination = `https://chain${index}.example.org/`;
			routes.set(destination, redirect(`https://chain${index}-a.example.net/`));
			routes.set(
				`https://chain${index}-a.example.net/`,
				redirect(`https://chain${index}-b.example.com/`)
			);
			routes.set(`https://chain${index}-b.example.com/`, redirect('/again'));
			const linkId = await addLink('t-check', destination);
			await apply('u-check', linkId, automation.id);
		}
		const counter = { queries: 0 };
		const summary = await check(counting(routing(), counter));
		console.log(JSON.stringify({ checkRun: counter.queries, requests: summary.requests }));
		expect(summary).toMatchObject({ claimed: 3, requests: 9, failed: 0 });
		expect(counter.queries).toBe(5);
		const idle = { queries: 0 };
		expect(await check(counting(routing(), idle))).toMatchObject({ claimed: 0 });
		expect(idle.queries).toBe(1);
	});
});
