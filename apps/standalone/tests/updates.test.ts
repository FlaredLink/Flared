// SPDX-License-Identifier: AGPL-3.0-only
// The opt-in update check against real D1: the feed's validation and fetch limits, the stored
// state, and that turning the check off stops the fetch and clears what it found.
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { availableRelease, newerVersion, parseRelease } from '../src/lib/updates';
import {
	checkForUpdates,
	feedUrl,
	fetchLatestRelease,
	readUpdateState,
	type FeedOptions
} from '../worker/updates';

const release = {
	version: '0.2.0',
	publishedAt: '2026-11-02T09:00:00.000Z',
	notesUrl: 'https://github.com/FlaredLink/Flared/releases/tag/v0.2.0',
	summary: 'Update notices.',
	migrations: true,
	breaking: false
};

const seen: Request[] = [];

function feed(respond: (request: Request) => Promise<Response> | Response): FeedOptions {
	return {
		fetch: async (request) => {
			seen.push(request);
			return respond(request);
		},
		timeoutMs: 50
	};
}

const serving = (body: unknown, init: ResponseInit = {}) =>
	feed(() => new Response(typeof body === 'string' ? body : JSON.stringify(body), init));

async function turn(enabled: boolean): Promise<void> {
	await env.IDENTITY.prepare(
		'INSERT INTO update_check (id, enabled, changed_at) VALUES (1, ?, 1) ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled'
	)
		.bind(enabled ? 1 : 0)
		.run();
}

beforeAll(async () => {
	await applyD1Migrations(env.IDENTITY, env.IDENTITY_MIGRATIONS);
});

beforeEach(async () => {
	seen.length = 0;
	await env.IDENTITY.prepare('DELETE FROM update_check').run();
});

describe('the release feed', () => {
	it('accepts the feed that the release script writes and ignores later fields', () => {
		expect(parseRelease({ ...release, channel: 'stable' })).toEqual(release);
	});

	it('refuses wrong types, a long summary, and notes outside the Flared releases', () => {
		for (const change of [
			{ version: 'v0.2.0' },
			{ version: '0.2' },
			{ publishedAt: 'soon' },
			{ notesUrl: 'https://example.com/FlaredLink/Flared/releases/tag/v0.2.0' },
			{ notesUrl: 'https://github.com/someone/Flared/releases/tag/v0.2.0' },
			{ summary: '' },
			{ summary: 'x'.repeat(281) },
			{ migrations: 'yes' },
			{ breaking: null }
		])
			expect(parseRelease({ ...release, ...change })).toBeNull();
		expect(parseRelease([release])).toBeNull();
		expect(parseRelease(null)).toBeNull();
	});

	it('compares versions by number', () => {
		expect(newerVersion('0.2.0', '0.1.0')).toBe(true);
		expect(newerVersion('0.10.0', '0.9.9')).toBe(true);
		expect(newerVersion('1.0.0', '0.99.99')).toBe(true);
		expect(newerVersion('0.1.0', '0.1.0')).toBe(false);
		expect(newerVersion('0.1.0', '0.2.0')).toBe(false);
		// A build that names no version is older than any release.
		expect(newerVersion('0.1.0', '')).toBe(true);
	});

	it('offers a release only when the check is on and the release is newer', () => {
		const state = { enabled: true, checkedAt: 1, failedAt: null, latest: release };
		expect(availableRelease(state, '0.1.0')).toEqual(release);
		expect(availableRelease(state, '0.2.0')).toBeNull();
		expect(availableRelease({ ...state, enabled: false }, '0.1.0')).toBeNull();
		expect(availableRelease(null, '0.1.0')).toBeNull();
	});
});

describe('fetching the feed', () => {
	it('asks one fixed HTTPS address with no cookie, no redirects, and a plain user agent', async () => {
		expect(await fetchLatestRelease(serving(release))).toEqual({ ok: true, release });
		const [request] = seen;
		expect(request.url).toBe(feedUrl);
		expect(feedUrl.startsWith('https://')).toBe(true);
		expect(request.redirect).toBe('manual');
		expect(request.headers.get('cookie')).toBeNull();
		expect(request.headers.get('user-agent')).toBe('Flared');
	});

	it('fails on a redirect, an error status, a network error, or a timeout', async () => {
		const redirect = serving('', {
			status: 302,
			headers: { location: 'https://example.com/latest.json' }
		});
		for (const options of [
			redirect,
			serving(release, { status: 500 }),
			feed(() => Promise.reject(new TypeError('network'))),
			feed(
				(request) =>
					new Promise<Response>((_, reject) =>
						request.signal.addEventListener('abort', () => reject(request.signal.reason))
					)
			)
		])
			expect(await fetchLatestRelease(options)).toEqual({ ok: false, reason: 'unreachable' });
	});

	it('fails on a body that is not JSON, has wrong types, or is over 16 KB', async () => {
		const large = JSON.stringify({ ...release, padding: 'x'.repeat(17 * 1024) });
		const streamed = new TextEncoder().encode(large);
		for (const options of [
			serving('{"version":'),
			serving({ ...release, migrations: 1 }),
			serving(large),
			// No content-length: the size cap applies while reading.
			feed(
				() =>
					new Response(
						new ReadableStream({
							start(controller) {
								controller.enqueue(streamed.slice(0, 9000));
								controller.enqueue(streamed.slice(9000));
								controller.close();
							}
						})
					)
			)
		])
			expect(await fetchLatestRelease(options)).toEqual({ ok: false, reason: 'invalid' });
	});
});

describe('the stored check', () => {
	it('stays off until the owner turns it on, and then fetches nothing', async () => {
		expect(await readUpdateState(env.IDENTITY)).toEqual({
			enabled: false,
			checkedAt: null,
			failedAt: null,
			latest: null
		});
		expect(await checkForUpdates(env.IDENTITY, serving(release), 10)).toBe('off');
		await turn(false);
		expect(await checkForUpdates(env.IDENTITY, serving(release), 10)).toBe('off');
		expect(seen).toHaveLength(0);
	});

	it('stores the latest release, and a failure keeps it', async () => {
		await turn(true);
		expect(await checkForUpdates(env.IDENTITY, serving(release), 10)).toBe('checked');
		expect(await readUpdateState(env.IDENTITY)).toEqual({
			enabled: true,
			checkedAt: 10,
			failedAt: null,
			latest: release
		});
		expect(await checkForUpdates(env.IDENTITY, serving('nope'), 20)).toBe('failed');
		expect(await readUpdateState(env.IDENTITY)).toEqual({
			enabled: true,
			checkedAt: 10,
			failedAt: 20,
			latest: release
		});
		expect(await checkForUpdates(env.IDENTITY, serving(release), 30)).toBe('checked');
		expect((await readUpdateState(env.IDENTITY)).failedAt).toBeNull();
	});

	it('writes nothing when the owner turns the check off during a fetch', async () => {
		await turn(true);
		const turnedOff = feed(async () => {
			await env.IDENTITY.prepare('UPDATE update_check SET enabled = 0 WHERE id = 1').run();
			return new Response(JSON.stringify(release));
		});
		await checkForUpdates(env.IDENTITY, turnedOff, 10);
		expect(await readUpdateState(env.IDENTITY)).toEqual({
			enabled: false,
			checkedAt: null,
			failedAt: null,
			latest: null
		});
	});
});
