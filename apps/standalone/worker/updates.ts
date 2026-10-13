// SPDX-License-Identifier: AGPL-3.0-only
// The opt-in update check. While the owner keeps it on, the daily job reads the Flared release
// feed and stores the latest release in identity D1. The request carries no cookie, no version,
// and no data about this installation. A failed check is recorded and changes nothing else, so
// the installation never depends on flared.page.
// /api/settings/updates: the owner turns the check on or off. Turning it on checks at once.
import { sessionPrincipal } from '@flared/server/api/compose';
import { resolveTenant } from '@flared/server/tenancy';
import type { AuthService } from '@flared/server/web';
import { offState, parseRelease, type Release, type UpdateState } from '../src/lib/updates';
import type { StandaloneConfig } from './config';

export const feedUrl = 'https://flared.page/releases/latest.json';
const maxFeedBytes = 16 * 1024;

export interface FeedOptions {
	fetch: (request: Request) => Promise<Response>;
	timeoutMs: number;
}

export const defaultFeed: FeedOptions = { fetch: (request) => fetch(request), timeoutMs: 5000 };

type FeedResult = { ok: true; release: Release } | { ok: false; reason: 'unreachable' | 'invalid' };

interface UpdateRow {
	enabled: number;
	checked_at: number | null;
	failed_at: number | null;
	latest_version: string | null;
	published_at: string | null;
	notes_url: string | null;
	summary: string | null;
	migrations: number | null;
	breaking: number | null;
}

export async function readUpdateState(identity: D1Database): Promise<UpdateState> {
	const row = await identity
		.prepare(
			'SELECT enabled, checked_at, failed_at, latest_version, published_at, notes_url, summary, migrations, breaking FROM update_check WHERE id = 1'
		)
		.first<UpdateRow>();
	if (!row) return offState;
	return {
		enabled: row.enabled === 1,
		checkedAt: row.checked_at,
		failedAt: row.failed_at,
		latest:
			row.latest_version === null
				? null
				: parseRelease({
						version: row.latest_version,
						publishedAt: row.published_at,
						notesUrl: row.notes_url,
						summary: row.summary,
						migrations: row.migrations === 1,
						breaking: row.breaking === 1
					})
	};
}

// The body as text, or null when it is longer than maxBytes.
async function boundedText(response: Response, maxBytes: number): Promise<string | null> {
	if (Number(response.headers.get('content-length')) > maxBytes) {
		await response.body?.cancel();
		return null;
	}
	if (!response.body) return '';
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > maxBytes) {
			await reader.cancel();
			return null;
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(bytes);
}

// HTTPS to one fixed address, no redirects, a time limit that covers the body, and a size cap.
export async function fetchLatestRelease(feed: FeedOptions): Promise<FeedResult> {
	let text: string | null;
	try {
		const response = await feed.fetch(
			new Request(feedUrl, {
				headers: { accept: 'application/json', 'user-agent': 'Flared' },
				redirect: 'manual',
				signal: AbortSignal.timeout(feed.timeoutMs)
			})
		);
		if (response.status !== 200) {
			await response.body?.cancel();
			return { ok: false, reason: 'unreachable' };
		}
		text = await boundedText(response, maxFeedBytes);
	} catch {
		return { ok: false, reason: 'unreachable' };
	}
	if (text === null) return { ok: false, reason: 'invalid' };
	let body: unknown = null;
	try {
		body = JSON.parse(text);
	} catch {
		// An unreadable body is invalid below.
	}
	const release = parseRelease(body);
	return release ? { ok: true, release } : { ok: false, reason: 'invalid' };
}

// The daily job, and the first check when the owner turns it on. Each write needs the check to
// be on still, so turning it off during a check leaves nothing behind.
export async function checkForUpdates(
	identity: D1Database,
	feed: FeedOptions,
	now: number
): Promise<'off' | 'checked' | 'failed'> {
	if (!(await readUpdateState(identity)).enabled) return 'off';
	const result = await fetchLatestRelease(feed);
	if (!result.ok) {
		console.error(JSON.stringify({ event: 'update_check_failed', reason: result.reason }));
		await identity
			.prepare('UPDATE update_check SET failed_at = ? WHERE id = 1 AND enabled = 1')
			.bind(now)
			.run();
		return 'failed';
	}
	const { release } = result;
	await identity
		.prepare(
			'UPDATE update_check SET checked_at = ?, failed_at = NULL, latest_version = ?, published_at = ?, notes_url = ?, summary = ?, migrations = ?, breaking = ? WHERE id = 1 AND enabled = 1'
		)
		.bind(
			now,
			release.version,
			release.publishedAt,
			release.notesUrl,
			release.summary,
			release.migrations ? 1 : 0,
			release.breaking ? 1 : 0
		)
		.run();
	return 'checked';
}

async function setEnabled(identity: D1Database, enabled: boolean, now: number): Promise<void> {
	await identity
		.prepare(
			enabled
				? 'INSERT INTO update_check (id, enabled, changed_at) VALUES (1, 1, ?) ON CONFLICT(id) DO UPDATE SET enabled = 1, changed_at = excluded.changed_at'
				: 'INSERT INTO update_check (id, enabled, changed_at) VALUES (1, 0, ?) ON CONFLICT(id) DO UPDATE SET enabled = 0, changed_at = excluded.changed_at, checked_at = NULL, failed_at = NULL, latest_version = NULL, published_at = NULL, notes_url = NULL, summary = NULL, migrations = NULL, breaking = NULL'
		)
		.bind(now)
		.run();
}

function failure(code: string, status: number, message: string): Response {
	return Response.json(
		{ error: { code, message, requestId: crypto.randomUUID() } },
		{ status, headers: { 'cache-control': 'no-store' } }
	);
}

function parseChoice(text: string): boolean | null {
	let body: unknown = null;
	try {
		body = JSON.parse(text);
	} catch {
		return null;
	}
	if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
	const entries = Object.entries(body);
	if (entries.length !== 1 || entries[0][0] !== 'enabled' || typeof entries[0][1] !== 'boolean')
		return null;
	return entries[0][1];
}

export async function handleUpdates(
	request: Request,
	config: StandaloneConfig,
	auth: AuthService,
	fixedTenantId: string,
	feed: FeedOptions
): Promise<Response> {
	if (new URL(request.url).pathname !== '/api/settings/updates')
		return failure('NOT_FOUND', 404, 'Route not found.');
	if (request.method !== 'POST') return failure('METHOD_NOT_ALLOWED', 405, 'Method not allowed.');
	if (request.headers.get('origin') !== config.origin)
		return failure('ORIGIN_REJECTED', 403, 'This request must come from the Flared app.');
	const principal = await sessionPrincipal(request, auth, config.origin);
	if (principal?.kind !== 'session') return failure('UNAUTHENTICATED', 401, 'Sign in to continue.');
	const tenant = await resolveTenant(config.identity, {
		userId: principal.userId,
		sessionId: principal.sessionId
	});
	if (tenant.status !== 'active' || tenant.tenantId !== fixedTenantId)
		return failure('NO_WORKSPACE', 403, 'Your account has no workspace.');
	if (tenant.role !== 'owner')
		return failure('OWNER_REQUIRED', 403, 'Only the workspace owner can change update checks.');
	if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))
		return failure('UNSUPPORTED_MEDIA_TYPE', 415, 'Send the choice as JSON.');
	const text = await request.text();
	if (text.length > 256) return failure('PAYLOAD_TOO_LARGE', 413, 'The request is too large.');
	const enabled = parseChoice(text);
	if (enabled === null) return failure('VALIDATION_FAILED', 422, 'Send enabled as true or false.');
	const now = Date.now();
	await setEnabled(config.identity, enabled, now);
	if (enabled) await checkForUpdates(config.identity, feed, now);
	return Response.json(
		{ ok: true, updates: await readUpdateState(config.identity) },
		{ headers: { 'cache-control': 'no-store' } }
	);
}
