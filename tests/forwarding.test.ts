// SPDX-License-Identifier: AGPL-3.0-only
// Click forwarding: the event's forward field, the redirect gate and visitor cookie, the utm_*
// tags, the consumer hook, the click batch budget, and the dead-letter strip.
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
	parseClickEvent,
	visitorIdPattern,
	withoutForward,
	type ClickEvent,
	type ClickForward,
	isPageViewEvent
} from '../packages/contracts/src/analytics';
import { applyAnalyticsPolicy } from '../packages/data/src/analytics';
import { findRedirectTarget } from '../packages/data/src/links';
import {
	applyRoutingPolicy,
	listClickForwardingTenants,
	setClickForwarding,
	setClickForwardingFlags
} from '../packages/data/src/routing-policy';
import { createClickConsumer, type QueueMessage } from '../packages/server/src/analytics';
import { utmTagsOf } from '../packages/server/src/clicks';
import {
	createDeadLetterConsumer,
	requeueDeadLetter,
	type DeadLetterMessage
} from '../packages/server/src/operations';
import { createRedirectHandler, snapshotLifetimeMs } from '../packages/server/src/redirect';
import { counting } from './support/d1-count';

const routing = () => env.FORWARDING_ROUTING;
const shard = () => env.FORWARDING_ANALYTICS;
const identity = () => env.FORWARDING_IDENTITY;
const start = Date.UTC(2026, 9, 18, 12);
const browser =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const iphone =
	'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const cookiePattern =
	/^flared_vid=([A-Za-z0-9_-]{22}); Max-Age=31536000; Path=\/; Secure; HttpOnly; SameSite=Lax$/;

beforeAll(async () => {
	await applyD1Migrations(routing(), env.ROUTING_MIGRATIONS, 'flared_core_migrations');
	await applyD1Migrations(shard(), env.ANALYTICS_MIGRATIONS, 'flared_core_migrations');
	await applyD1Migrations(identity(), env.IDENTITY_MIGRATIONS, 'flared_core_migrations');
	await routing().batch([
		routing().prepare(
			"INSERT INTO domain_namespaces (id, hostname, created_at) VALUES ('dom-short', 'short.example', 0)"
		),
		routing().prepare(
			"INSERT INTO domains (id, tenant_id, state, is_default, created_at, updated_at) VALUES ('dom-short', NULL, 'active', 1, 0, 0)"
		),
		// t-fwd forwards; t-free has the flag but no integrations; t-old has no stored limit;
		// t-off has integrations without the flag.
		routing().prepare(
			"INSERT INTO tenant_policy (tenant_id, revision, analytics_shard_id, active_link_limit, domain_limit, webhook_endpoint_limit, automation_limit, updated_at) VALUES ('t-fwd', 1, 'analytics-1', 100, 1, 5, 25, 0), ('t-free', 1, 'analytics-1', 100, 1, 0, 0, 0), ('t-old', 1, 'analytics-1', 100, 1, NULL, NULL, 0), ('t-off', 1, 'analytics-1', 100, 1, 5, 25, 0)"
		)
	]);
	for (const tenant of ['t-fwd', 't-free', 't-old'])
		expect(await setClickForwarding(routing(), tenant, true, 1)).toBe(true);
});

afterEach(() => {
	vi.restoreAllMocks();
});

let linkCounter = 0;
async function addLink(
	slug: string,
	destination: string,
	options: { tenant?: string; ios?: string } = {}
) {
	linkCounter += 1;
	await routing().batch([
		routing()
			.prepare("INSERT INTO slug_reservations (domain_id, slug) VALUES ('dom-short', ?)")
			.bind(slug),
		routing()
			.prepare(
				"INSERT INTO links (id, tenant_id, domain_id, slug, destination, ios_destination, title, status, created_at, updated_at) VALUES (?, ?, 'dom-short', ?, ?, ?, NULL, 'active', 0, 0)"
			)
			.bind(`fl-${linkCounter}`, options.tenant ?? 't-fwd', slug, destination, options.ios ?? null)
	]);
}

let cacheCounter = 0;
function handler(options: { now?: () => number; cacheName?: string; sink?: boolean } = {}) {
	cacheCounter += 1;
	const events: ClickEvent[] = [];
	const app = createRedirectHandler({
		routing: routing(),
		appOrigin: 'https://app.example',
		cacheName: options.cacheName ?? `forwarding-test-${cacheCounter}`,
		clicks:
			options.sink === false
				? undefined
				: { send: async (event) => void (isPageViewEvent(event) || events.push(event)) },
		now: options.now ?? (() => start)
	});
	const visit = (slug: string, headers: Record<string, string> = {}, method = 'GET') =>
		app.fetch(
			new Request(`https://short.example/${slug}`, {
				method,
				headers: { 'user-agent': browser, ...headers },
				redirect: 'manual'
			})
		);
	return { visit, events };
}

function cookieOf(response: Response): string | null {
	const header = response.headers.get('set-cookie');
	if (header === null) return null;
	const match = cookiePattern.exec(header);
	expect(match, header).not.toBeNull();
	return match?.[1] ?? null;
}

function event(change: Partial<ClickEvent> = {}): ClickEvent {
	return {
		schemaVersion: 1,
		eventId: crypto.randomUUID(),
		tenantId: 't-fwd',
		analyticsShardId: 'analytics-1',
		linkId: 'link-1',
		kind: 'production',
		occurredAt: start,
		country: 'DE',
		deviceCategory: 'desktop',
		referrerHostname: 'unknown',
		browser: 'chrome',
		os: 'macos',
		...change
	};
}

const forward: ClickForward = {
	visitorId: 'AAAAAAAAAAAAAAAAAAAAAw',
	userAgent: browser,
	shortUrl: 'https://short.example/launch',
	utm: { utm_source: 'news', utm_id: '7' }
};

describe('event contract', () => {
	it('accepts the forward field and keeps schema version 1', () => {
		const value = event({ forward });
		expect(parseClickEvent(JSON.parse(JSON.stringify(value)))).toEqual(value);
		const bare = event({ forward: { shortUrl: forward.shortUrl } });
		expect(parseClickEvent(bare)).toEqual(bare);
		expect(parseClickEvent({ ...value, schemaVersion: 2 })).toBeNull();
	});

	it('refuses unknown nested keys and out-of-range values', () => {
		const bad: unknown[] = [
			{ ...forward, ip: '192.0.2.1' },
			{ ...forward, destination: 'https://example.com/' },
			{ ...forward, utm: { utm_source: 'a', utm_foo: 'b' } },
			{ ...forward, utm: {} },
			{ ...forward, utm: { utm_source: '' } },
			{ ...forward, utm: { utm_source: 'x'.repeat(101) } },
			{ ...forward, utm: { utm_source: 'a\nb' } },
			{ ...forward, utm: { utm_source: 7 } },
			{ ...forward, utm: 'utm_source=a' },
			{ ...forward, userAgent: '' },
			{ ...forward, userAgent: 'x'.repeat(513) },
			{ ...forward, userAgent: 'Mozilla/5.0 é' },
			{ ...forward, userAgent: 'Mozilla/5.0\t(X11)' },
			{ ...forward, shortUrl: 'http://short.example/launch' },
			{ ...forward, shortUrl: 'https://short.example/launch?utm_source=a' },
			{ ...forward, shortUrl: 'https://short.example/' },
			{ ...forward, shortUrl: 'https://user@short.example/launch' },
			{ ...forward, shortUrl: `https://${`${'a'.repeat(60)}.`.repeat(5)}example/launch` },
			{ visitorId: forward.visitorId, userAgent: browser },
			'forward',
			null,
			[forward]
		];
		for (const value of bad)
			expect(parseClickEvent(event({ forward: value as ClickForward }))).toBeNull();
		expect(
			parseClickEvent(event({ forward: { ...forward, utm: { utm_source: 'x'.repeat(100) } } }))
		).not.toBeNull();
		expect(
			parseClickEvent(event({ forward: { ...forward, userAgent: 'x'.repeat(512) } }))
		).not.toBeNull();
	});

	it('accepts only a 22-character base64url visitor ID of 128 bits', () => {
		const ids: [string, boolean][] = [
			['AAAAAAAAAAAAAAAAAAAAAw', true],
			['_-_-_-_-_-_-_-_-_-_-_Q', true],
			['AAAAAAAAAAAAAAAAAAAAAg', true],
			['AAAAAAAAAAAAAAAAAAAAAB', false],
			['AAAAAAAAAAAAAAAAAAAAA', false],
			['AAAAAAAAAAAAAAAAAAAAAAA', false],
			['AAAAAAAAAAAAAAAAAAAA+w', false],
			['AAAAAAAAAAAAAAAAAAAAA=', false],
			['', false]
		];
		for (const [visitorId, valid] of ids) {
			expect(visitorIdPattern.test(visitorId), visitorId).toBe(valid);
			const parsed = parseClickEvent(event({ forward: { ...forward, visitorId } }));
			expect(parsed !== null, visitorId).toBe(valid);
		}
		expect(
			parseClickEvent(event({ forward: { ...forward, visitorId: 7 as unknown as string } }))
		).toBeNull();
	});

	it('strips the forward field without changing the event', () => {
		const value = event({ forward });
		const stripped = withoutForward(value);
		expect(stripped).toEqual(event({ eventId: value.eventId }));
		expect('forward' in stripped).toBe(false);
		expect(value.forward).toEqual(forward);
	});
});

describe('routing flag', () => {
	it('is set only through setClickForwarding and listed in tenant order', async () => {
		expect(await setClickForwarding(routing(), 't-fwd', true, 2)).toBe(false);
		expect(await setClickForwarding(routing(), 't-missing', true, 2)).toBe(false);
		expect(await listClickForwardingTenants(routing(), '', 500)).toEqual([
			't-free',
			't-fwd',
			't-old'
		]);
		expect(await listClickForwardingTenants(routing(), 't-free', 1)).toEqual(['t-fwd']);
		for (const limit of [0, 501, 1.5])
			await expect(listClickForwardingTenants(routing(), '', limit)).rejects.toThrow();
	});

	it('is set for several workspaces in one statement', async () => {
		await routing()
			.prepare(
				"INSERT INTO tenant_policy (tenant_id, revision, analytics_shard_id, active_link_limit, domain_limit, webhook_endpoint_limit, automation_limit, updated_at) VALUES ('t-many-a', 1, 'analytics-1', 100, 1, 5, 25, 0), ('t-many-b', 1, 'analytics-1', 100, 1, 5, 25, 0)"
			)
			.run();
		expect(
			await setClickForwardingFlags(
				routing(),
				[
					{ tenantId: 't-many-a', on: true },
					{ tenantId: 't-many-b', on: false },
					{ tenantId: 't-missing', on: true }
				],
				4
			)
		).toBe(1);
		expect(await listClickForwardingTenants(routing(), 't-many', 500)).toContain('t-many-a');
		expect(await listClickForwardingTenants(routing(), 't-many', 500)).not.toContain('t-many-b');
		expect(await setClickForwardingFlags(routing(), [{ tenantId: 't-many-a', on: false }], 5)).toBe(
			1
		);
		expect(await setClickForwardingFlags(routing(), [], 5)).toBe(0);
		await expect(
			setClickForwardingFlags(
				routing(),
				Array.from({ length: 101 }, (_, index) => ({ tenantId: `t-${index}`, on: true })),
				5
			)
		).rejects.toThrow();
	});

	it('survives a newer policy projection', async () => {
		await routing()
			.prepare(
				"INSERT INTO tenant_policy (tenant_id, revision, analytics_shard_id, active_link_limit, domain_limit, webhook_endpoint_limit, automation_limit, updated_at) VALUES ('t-proj', 1, 'analytics-1', 100, 1, 5, 25, 0)"
			)
			.run();
		expect(await setClickForwarding(routing(), 't-proj', true, 3)).toBe(true);
		await applyRoutingPolicy(routing(), {
			tenantId: 't-proj',
			revision: 2,
			analyticsShardId: 'analytics-1',
			activeLinkLimit: 200,
			domainLimit: 2,
			webhookEndpointLimit: 5,
			automationLimit: 25,
			linkAccess: 0,
			linkPreviews: 0,
			pageLimit: 0,
			pageExtras: 0,
			suspendedAt: null,
			now: 4
		});
		const row = await routing()
			.prepare("SELECT revision, click_forwarding FROM tenant_policy WHERE tenant_id = 't-proj'")
			.first();
		expect(row).toEqual({ revision: 2, click_forwarding: 1 });
		expect(await setClickForwarding(routing(), 't-proj', false, 5)).toBe(true);
		expect(await listClickForwardingTenants(routing(), 't-old', 10)).toEqual([]);
	});

	it('refuses a value other than 0 or 1 in the column', async () => {
		await expect(
			routing()
				.prepare("UPDATE tenant_policy SET click_forwarding = 2 WHERE tenant_id = 't-off'")
				.run()
		).rejects.toThrow();
	});
});

describe('redirect gate', () => {
	it('forwards only with the flag and a webhook endpoint limit above 0, in the same lookup', async () => {
		const cases: [string, boolean][] = [
			['t-fwd', true],
			['t-free', false],
			['t-old', false],
			['t-off', false]
		];
		for (const [tenant, forwards] of cases) {
			const slug = `gate-${tenant.slice(2)}`;
			await addLink(slug, 'https://example.com/page?utm_source=news', { tenant });
			const counter = { queries: 0 };
			// The lookup reads the primary through a session; count the statements of that session.
			const session = { withSession: () => counting(routing(), counter) };
			const lookup = await findRedirectTarget(
				session as unknown as D1Database,
				'short.example',
				slug
			);
			expect(counter.queries, tenant).toBe(1);
			expect(lookup?.kind === 'target' && lookup.target.forwardClicks, tenant).toBe(forwards);

			const { visit, events } = handler();
			const response = await visit(slug);
			expect(response.status, tenant).toBe(302);
			expect(response.headers.get('set-cookie') !== null, tenant).toBe(forwards);
			expect(response.headers.get('cache-control'), tenant).toBe(
				forwards ? 'private, no-store' : 'no-store'
			);
			expect(events, tenant).toHaveLength(1);
			expect('forward' in events[0], tenant).toBe(forwards);
			if (!forwards)
				expect(JSON.stringify(events[0]), tenant).not.toMatch(/Mozilla|utm|flared_vid/);
		}
	});

	it('sends no cookie and no event to HEAD, automated clients, or without a click sink', async () => {
		await addLink('gate-quiet', 'https://example.com/quiet');
		const { visit, events } = handler();
		const responses = [
			await visit('gate-quiet', {}, 'HEAD'),
			await visit('gate-quiet', { 'user-agent': 'curl/8.7.1' }),
			await visit('gate-quiet', { 'user-agent': 'Slackbot-LinkExpanding 1.0' }),
			await visit('gate-quiet', { 'user-agent': '' }),
			await handler({ sink: false }).visit('gate-quiet')
		];
		for (const response of responses) {
			expect(response.status).toBe(302);
			expect(response.headers.get('location')).toBe('https://example.com/quiet');
			expect(response.headers.get('set-cookie')).toBeNull();
			expect(response.headers.get('cache-control')).toBe('no-store');
		}
		expect(events).toEqual([]);
	});

	it('follows a flag change within the snapshot bound', async () => {
		await routing()
			.prepare(
				"INSERT INTO tenant_policy (tenant_id, revision, analytics_shard_id, active_link_limit, domain_limit, webhook_endpoint_limit, automation_limit, updated_at) VALUES ('t-flip', 1, 'analytics-1', 100, 1, 5, 25, 0)"
			)
			.run();
		await setClickForwarding(routing(), 't-flip', true, 1);
		await addLink('gate-flip', 'https://example.com/flip', { tenant: 't-flip' });
		let time = start;
		const { visit, events } = handler({ now: () => time });
		expect((await visit('gate-flip')).headers.get('set-cookie')).not.toBeNull();
		await setClickForwarding(routing(), 't-flip', false, 2);
		// The snapshot still carries the flag until its deadline.
		expect((await visit('gate-flip')).headers.get('set-cookie')).not.toBeNull();
		time += snapshotLifetimeMs;
		const after = await visit('gate-flip');
		expect(after.headers.get('set-cookie')).toBeNull();
		expect(events.map((item) => 'forward' in item)).toEqual([true, true, false]);
	});

	it('treats a snapshot without the flag as a miss', async () => {
		await addLink('gate-v3', 'https://example.com/current');
		const cacheName = `forwarding-v3-${cacheCounter}`;
		const stale = {
			tenantId: 't-fwd',
			linkId: 'fl-old',
			analyticsShardId: 'analytics-1',
			destination: 'https://example.com/stale',
			iosDestination: null,
			androidDestination: null,
			validUntil: start + snapshotLifetimeMs
		};
		await (
			await caches.open(cacheName)
		).put(
			new Request('https://short.example/gate-v3'),
			new Response(JSON.stringify(stale), {
				headers: { 'content-type': 'application/json', 'cache-control': 'max-age=60' }
			})
		);
		const response = await handler({ cacheName }).visit('gate-v3');
		expect(response.headers.get('location')).toBe('https://example.com/current');
	});
});

describe('visitor cookie', () => {
	it('is set once on the short-link host and its value rides the event', async () => {
		await addLink('vid-new', 'https://example.com/a');
		const { visit, events } = handler();
		const first = await visit('vid-new');
		const value = cookieOf(first);
		expect(value).toMatch(visitorIdPattern);
		expect(first.headers.get('set-cookie')).not.toMatch(/Domain=/i);
		expect(events[0].forward).toEqual({
			visitorId: value,
			userAgent: browser,
			shortUrl: 'https://short.example/vid-new'
		});
		expect(parseClickEvent(JSON.parse(JSON.stringify(events[0])))).toEqual(events[0]);

		const again = await visit('vid-new', { cookie: `theme=dark; flared_vid=${value}` });
		expect(again.headers.get('set-cookie')).toBeNull();
		expect(again.headers.get('cache-control')).toBe('no-store');
		expect(events[1].forward?.visitorId).toBe(value);

		const other = await visit('vid-new');
		expect(cookieOf(other)).not.toBe(value);
	});

	it('replaces a malformed value', async () => {
		await addLink('vid-bad', 'https://example.com/b');
		const { visit, events } = handler();
		for (const cookie of [
			'flared_vid=short',
			'flared_vid=AAAAAAAAAAAAAAAAAAAAAB',
			'flared_vid=',
			'flared_vid_x=AAAAAAAAAAAAAAAAAAAAAw'
		]) {
			const response = await visit('vid-bad', { cookie });
			const value = cookieOf(response);
			expect(value, cookie).toMatch(visitorIdPattern);
			expect(response.headers.get('cache-control'), cookie).toBe('private, no-store');
			expect(events.at(-1)?.forward?.visitorId, cookie).toBe(value);
		}
		const kept = await visit('vid-bad', {
			cookie: 'flared_vid=bad; flared_vid=AAAAAAAAAAAAAAAAAAAAAw'
		});
		expect(kept.headers.get('set-cookie')).toBeNull();
		expect(events.at(-1)?.forward?.visitorId).toBe('AAAAAAAAAAAAAAAAAAAAAw');
	});

	it('is never read, set, or renewed with Sec-GPC: 1', async () => {
		await addLink('vid-gpc', 'https://example.com/c?utm_medium=email');
		const { visit, events } = handler();
		for (const cookie of [undefined, 'flared_vid=AAAAAAAAAAAAAAAAAAAAAw']) {
			const response = await visit('vid-gpc', {
				'sec-gpc': '1',
				...(cookie ? { cookie } : {})
			});
			expect(response.status).toBe(302);
			expect(response.headers.get('set-cookie')).toBeNull();
			expect(response.headers.get('cache-control')).toBe('no-store');
		}
		expect(events.map((item) => item.forward)).toEqual([
			{
				userAgent: browser,
				shortUrl: 'https://short.example/vid-gpc',
				utm: { utm_medium: 'email' }
			},
			{
				userAgent: browser,
				shortUrl: 'https://short.example/vid-gpc',
				utm: { utm_medium: 'email' }
			}
		]);
		expect((await visit('vid-gpc', { 'sec-gpc': '0' })).headers.get('set-cookie')).not.toBeNull();
	});

	it('is absent from links of workspaces that do not forward, also with a cookie sent', async () => {
		await addLink('vid-off', 'https://example.com/d', { tenant: 't-off' });
		const { visit, events } = handler();
		const response = await visit('vid-off', { cookie: 'flared_vid=AAAAAAAAAAAAAAAAAAAAAw' });
		expect(response.headers.get('set-cookie')).toBeNull();
		expect(events[0].forward).toBeUndefined();
	});
});

describe('utm tags and user agent', () => {
	it('come from the location sent, also a device destination', async () => {
		await addLink(
			'utm-device',
			'https://example.com/web?utm_source=web&utm_campaign=launch&token=secret',
			{ ios: 'myapp://item/42?utm_source=app&utm_content=banner' }
		);
		const { visit, events } = handler();
		await visit('utm-device');
		await visit('utm-device', { 'user-agent': iphone });
		expect(events.map((item) => item.forward?.utm)).toEqual([
			{ utm_source: 'web', utm_campaign: 'launch' },
			{ utm_source: 'app', utm_content: 'banner' }
		]);
		expect(events[1].forward?.userAgent).toBe(iphone);
		expect(JSON.stringify(events)).not.toMatch(/secret|example\.com|myapp|item\/42/);
	});

	it('keep only the allowlisted tags, cleaned and cut at 100 characters', () => {
		const long = 'x'.repeat(150);
		expect(
			utmTagsOf(
				`https://example.com/?utm_source=a%00b%0Ac&utm_medium=${long}&utm_term=+&utm_id=7&utm_id=8&utm_foo=bar&utm_content=two+words&UTM_CAMPAIGN=caps`
			)
		).toEqual({
			utm_source: 'abc',
			utm_medium: 'x'.repeat(100),
			utm_id: '7',
			utm_content: 'two words'
		});
		// A cut does not split a surrogate pair.
		const emoji = `${'y'.repeat(99)}😀`;
		expect(utmTagsOf(`https://example.com/?utm_source=${encodeURIComponent(emoji)}`)).toEqual({
			utm_source: 'y'.repeat(99)
		});
		expect(utmTagsOf('https://example.com/?q=1')).toBeUndefined();
		expect(utmTagsOf('intent://item/42#Intent;scheme=myapp;end')).toBeUndefined();
		expect(utmTagsOf('not a url')).toBeUndefined();
	});

	it('cut the user agent at 512 printable ASCII characters', async () => {
		await addLink('utm-agent', 'https://example.com/agent');
		const { visit, events } = handler();
		const long = `${browser} ${'z'.repeat(600)}`;
		await visit('utm-agent', { 'user-agent': long });
		await visit('utm-agent', { 'user-agent': `Mozilla/5.0\t(X11; Linux x86_64) Firefox/130.0` });
		expect(events[0].forward?.userAgent).toBe(long.slice(0, 512));
		expect(events[1].forward?.userAgent).toBe('Mozilla/5.0(X11; Linux x86_64) Firefox/130.0');
		for (const item of events) expect(parseClickEvent(item)).toEqual(item);
		expect(events.every((item) => !('utm' in (item.forward ?? {})))).toBe(true);
	});
});

function message(body: unknown) {
	const state = { acked: false, retried: false };
	const value: QueueMessage = {
		body,
		ack: () => {
			state.acked = true;
		},
		retry: () => {
			state.retried = true;
		}
	};
	return { value, state };
}

describe('consumer hook', () => {
	beforeAll(async () => {
		await applyAnalyticsPolicy(shard(), {
			tenantId: 't-fwd',
			revision: 1,
			monthlyClickLimit: 3,
			retentionDays: 30,
			now: 0
		});
	});

	it('gets the admitted events that carry forward, once per batch', async () => {
		const forwarded: ClickEvent[][] = [];
		const first = event({ forward });
		const plain = event();
		const second = event({ forward: { shortUrl: forward.shortUrl } });
		const over = event({ forward });
		const bodies = [
			first,
			first,
			plain,
			second,
			over,
			event({ forward, tenantId: 't-unprojected' }),
			event({ forward, kind: 'test', checkId: 'check-1' }),
			{ ...event(), forward: { ...forward, ip: '192.0.2.1' } }
		];
		const messages = bodies.map(message);
		const results = await createClickConsumer({
			shards: { 'analytics-1': shard() },
			now: () => start,
			forward: async (events) => void forwarded.push([...events])
		})({ messages: messages.map((item) => item.value) });
		expect(results).toEqual([
			'admitted',
			'duplicate',
			'admitted',
			'admitted',
			'skipped',
			'retry',
			'dropped',
			'dropped'
		]);
		expect(forwarded).toEqual([[first, second]]);
	});

	it('is not called without forwarded events and logs a failure without retrying a click', async () => {
		const calls: number[] = [];
		await createClickConsumer({
			shards: { 'analytics-1': shard() },
			now: () => start,
			forward: async (events) => void calls.push(events.length)
		})({ messages: [message(event({ tenantId: 't-unprojected', forward })).value] });
		expect(calls).toEqual([]);

		await applyAnalyticsPolicy(shard(), {
			tenantId: 't-fail',
			revision: 1,
			monthlyClickLimit: 100,
			retentionDays: 30,
			now: 0
		});
		const logged: string[] = [];
		vi.spyOn(console, 'error').mockImplementation(
			(line: unknown) => void logged.push(String(line))
		);
		const messages = [
			event({ tenantId: 't-fail', forward }),
			event({ tenantId: 't-fail', forward })
		].map(message);
		const results = await createClickConsumer({
			shards: { 'analytics-1': shard() },
			now: () => start,
			forward: async () => {
				throw new Error(`queue down ${browser}`);
			}
		})({ messages: messages.map((item) => item.value) });
		expect(results).toEqual(['admitted', 'admitted']);
		expect(messages.map((item) => item.state)).toEqual([
			{ acked: true, retried: false },
			{ acked: true, retried: false }
		]);
		expect(logged).toEqual([JSON.stringify({ event: 'click_forward_failed', count: 2 })]);
	});

	it('keeps the click batch budget: no added statement for events that carry forward', async () => {
		await applyAnalyticsPolicy(shard(), {
			tenantId: 't-budget',
			revision: 1,
			monthlyClickLimit: 100,
			retentionDays: 30,
			now: 0
		});
		const run = async (withForward: boolean) => {
			const counter = { queries: 0 };
			let calls = 0;
			const results = await createClickConsumer({
				shards: { 'analytics-1': counting(shard(), counter) },
				now: () => start,
				forward: async () => {
					calls += 1;
				}
			})({
				messages: [1, 2, 3].map(
					() => message(event({ tenantId: 't-budget', ...(withForward ? { forward } : {}) })).value
				)
			});
			expect(results).toEqual(['admitted', 'admitted', 'admitted']);
			return { queries: counter.queries, calls };
		};
		const without = await run(false);
		const withField = await run(true);
		expect(without).toEqual({ queries: 43, calls: 0 });
		expect(withField).toEqual({ queries: 43, calls: 1 });
	});
});

describe('dead letters', () => {
	it('store the event without forward, so a requeued click is not forwarded', async () => {
		const value = event({ forward });
		const state = { acked: false };
		const item: DeadLetterMessage = {
			id: 'm-forward',
			body: JSON.parse(JSON.stringify(value)),
			ack: () => {
				state.acked = true;
			},
			retry: () => {}
		};
		await createDeadLetterConsumer({ identity: identity(), now: () => start })({
			messages: [item]
		});
		expect(state.acked).toBe(true);
		const row = await identity()
			.prepare('SELECT event FROM dead_letters WHERE id = ?')
			.bind(`event:${value.eventId}`)
			.first<{ event: string }>();
		expect(row?.event).toBe(JSON.stringify(withoutForward(value)));
		expect(row?.event).not.toMatch(/Mozilla|visitorId|utm_|short\.example/);
		const sent: ClickEvent[] = [];
		expect(
			await requeueDeadLetter(
				identity(),
				{ send: async (body) => void (isPageViewEvent(body) || sent.push(body)) },
				`event:${value.eventId}`,
				start
			)
		).toBe('requeued');
		expect(sent).toEqual([withoutForward(value)]);
	});
});
