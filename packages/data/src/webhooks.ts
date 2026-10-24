// SPDX-License-Identifier: AGPL-3.0-only
// Routing-store records for webhooks: endpoints, the event outbox, and deliveries; and the click
// milestones that the analytics shards hand over. Link events are staged by links.ts in the
// batch of the change, with the fragments below. An endpoint has a transport: 'http' is the
// signed POST that the webhook routes manage; the endpoints of another transport belong to the
// edition that sends them and are managed with the transport functions below.
import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types/index.ts';
import {
	defaultMilestoneInterval,
	isSubscribableWebhookEvent,
	isWebhookEventType,
	isWebhookOffReason,
	maxMilestoneInterval,
	milestoneStep,
	minMilestoneInterval,
	webhookDeliveryErrors,
	type SubscribableWebhookEvent,
	type WebhookDeliveryError,
	type WebhookDeliveryState,
	type WebhookEventType,
	type WebhookOffReason
} from '@flared/contracts/webhooks';

// A delivery is tried at most this many times, then fails.
export const webhookMaxAttempts = 10;
// A delivery still pending after this long fails as expired.
export const webhookDeliveryLifetimeMs = 72 * 60 * 60 * 1000;
// Events and deliveries are kept this long.
export const webhookRecordLifetimeMs = 30 * 86400000;
export const recentDeliveryCount = 50;
// The transport of the signed POST, and the key_id of every endpoint of another transport.
export const httpTransport = 'http';
export const transportKeyId = 'transport';
// Integration messages staged in one call at most.
export const maxIntegrationMessages = 100;

// SQL: whether the tenant bound to `tenant` has webhooks on. A limit of 0, or one not projected
// yet (NULL), turns them off.
export function webhooksOn(tenant: string): string {
	return `COALESCE((SELECT webhook_endpoint_limit FROM tenant_policy WHERE tenant_id = ${tenant}), 0) > 0 AND EXISTS (SELECT 1 FROM webhook_endpoints WHERE tenant_id = ${tenant} AND enabled = 1)`;
}

// SQL: a millisecond time column as ISO 8601 in UTC, as Date.toISOString writes it.
export function isoTime(column: string): string {
	return `strftime('%Y-%m-%dT%H:%M:%S', ${column} / 1000, 'unixepoch') || '.' || printf('%03d', ${column} % 1000) || 'Z'`;
}

// SQL: the public link of a links row `l` and its domain namespace `n`, with the keys and values
// of toApiLink in its order, so the JSON text is the same as the API's. A NULL time stays null.
export function linkJson(l: string, n: string): string {
	return `json_object('id', ${l}.id, 'domainId', ${l}.domain_id, 'hostname', ${n}.hostname, 'slug', ${l}.slug,
		'shortUrl', 'https://' || ${n}.hostname || '/' || ${l}.slug, 'destination', ${l}.destination, 'title', ${l}.title,
		'iosDestination', ${l}.ios_destination, 'androidDestination', ${l}.android_destination,
		'startsAt', ${isoTime(`${l}.starts_at`)}, 'endsAt', ${isoTime(`${l}.ends_at`)},
		'endedDestination', ${l}.ended_destination,
		'hasPassword', json(CASE WHEN ${l}.password_hash IS NULL THEN 'false' ELSE 'true' END),
		'previewTitle', ${l}.preview_title, 'previewDescription', ${l}.preview_description,
		'previewImage', CASE WHEN ${l}.preview_image IS NULL THEN NULL ELSE 'https://' || ${n}.hostname || '/' || ${l}.slug || '/preview/' || ${l}.preview_image END,
		'enabled', json(CASE ${l}.status WHEN 'active' THEN 'true' ELSE 'false' END),
		'blocked', json(CASE WHEN ${l}.blocked_reason IS NULL THEN 'null' ELSE json_object('reason', ${l}.blocked_reason) END),
		'createdAt', ${isoTime(`${l}.created_at`)}, 'updatedAt', ${isoTime(`${l}.updated_at`)})`;
}

export interface WebhookEndpointRow {
	id: string;
	tenantId: string;
	transport: string;
	// Set for an endpoint of another transport: unique per workspace and transport.
	targetKey: string | null;
	// The edition's JSON for another transport; the core never reads it.
	target: string | null;
	// Why Flared turned the endpoint off.
	offReason: WebhookOffReason | null;
	url: string;
	events: SubscribableWebhookEvent[];
	milestoneInterval: number | null;
	enabled: boolean;
	secretVersion: number;
	previousSecretUntil: number | null;
	keyId: string;
	failureCount: number;
	pausedUntil: number | null;
	lastSuccessAt: number | null;
	lastFailureAt: number | null;
	// Set for a hook: it gets no event that happens at or after this time.
	expiresAt: number | null;
	createdAt: number;
	updatedAt: number;
}

export interface NewWebhookEndpoint {
	id: string;
	tenantId: string;
	url: string;
	events: SubscribableWebhookEvent[];
	milestoneInterval: number | null;
	keyId: string;
	now: number;
}

export type CreateEndpointResult =
	| { status: 'created'; endpoint: WebhookEndpointRow }
	| { status: 'limit'; limit: number }
	| { status: 'no_workspace' };

// An endpoint of another transport. url is an https link that opens the target. events may be
// empty: the endpoint then gets only the events that target it. limit caps the workspace's
// endpoints on this transport; the http endpoints do not count.
export interface NewTransportEndpoint {
	id: string;
	tenantId: string;
	transport: string;
	targetKey: string;
	target: string | null;
	url: string;
	events: SubscribableWebhookEvent[];
	milestoneInterval: number | null;
	limit: number;
	now: number;
}

// limit: 0 while the workspace has webhooks off, else the limit asked for. taken: the workspace
// has an endpoint with this target key on the transport.
export type CreateTransportEndpointResult =
	| { status: 'created'; endpoint: WebhookEndpointRow }
	| { status: 'limit'; limit: number }
	| { status: 'taken' }
	| { status: 'no_workspace' };

// An endpoint of another transport with what a scheduled job needs of its workspace. on: the
// workspace has webhooks on and is not suspended.
export interface TransportEndpointState extends WebhookEndpointRow {
	analyticsShardId: string;
	on: boolean;
}

// A message for one endpoint of another transport. payload is the edition's JSON text; id is
// stable, so a repeat stages nothing twice.
export interface IntegrationMessage {
	id: string;
	tenantId: string;
	endpointId: string;
	payload: string;
	createdAt: number;
}

// undefined keeps a field.
export interface WebhookEndpointChange {
	url?: string;
	events?: SubscribableWebhookEvent[];
	milestoneInterval?: number;
	enabled?: boolean;
	now: number;
}

export interface WebhookEventRow {
	id: string;
	tenantId: string;
	type: WebhookEventType;
	subjectId: string | null;
	targetEndpointId: string | null;
	payload: string;
	createdAt: number;
	fannedOutAt: number | null;
}

export interface WebhookDeliveryRow {
	id: string;
	eventId: string;
	eventType: WebhookEventType;
	state: WebhookDeliveryState;
	attempts: number;
	responseStatus: number | null;
	errorCode: WebhookDeliveryError | null;
	durationMs: number | null;
	createdAt: number;
	lastAttemptAt: number | null;
	completedAt: number | null;
}

// A claimed delivery with what sending it needs.
export interface ClaimedDelivery {
	id: string;
	tenantId: string;
	// This attempt included.
	attempts: number;
	event: {
		id: string;
		type: WebhookEventType;
		payload: string;
		createdAt: number;
		targeted: boolean;
	};
	endpoint: {
		id: string;
		transport: string;
		// The edition's JSON for another transport.
		target: string | null;
		url: string;
		enabled: boolean;
		secretVersion: number;
		previousSecretUntil: number | null;
		keyId: string;
	};
}

// retry: the attempt failed and a later one may succeed; after the last attempt it fails.
export interface DeliveryResult {
	id: string;
	endpointId: string;
	outcome: 'succeeded' | 'retry' | 'failed' | 'skipped';
	responseStatus: number | null;
	errorCode: WebhookDeliveryError | null;
	durationMs: number | null;
}

export interface ClickMilestone {
	id: string;
	tenantId: string;
	linkId: string;
	clicks: number;
	createdAt: number;
}

function text(value: unknown, field: string): string {
	if (typeof value !== 'string' || !value) throw new Error(`Invalid stored ${field}`);
	return value;
}

function count(value: unknown, field: string): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
		throw new Error(`Invalid stored ${field}`);
	return value;
}

function optionalCount(value: unknown, field: string): number | null {
	return value === null ? null : count(value, field);
}

function optionalText(value: unknown, field: string): string | null {
	return value === null ? null : text(value, field);
}

function batchSize(limit: number, max: number): number {
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > max)
		throw new Error('Invalid webhook batch size');
	return limit;
}

// 2 to 16 lowercase letters, as the column allows.
function transportName(value: string): string {
	if (!/^[a-z]{2,16}$/.test(value)) throw new Error('Invalid webhook transport');
	return value;
}

// A transport other than http, for the transport functions.
function otherTransport(value: string): string {
	if (transportName(value) === httpTransport) throw new Error('Use the webhook functions for http');
	return value;
}

function targetKey(value: string): string {
	if (!value || value.length > 160) throw new Error('Invalid webhook target key');
	return value;
}

function offReason(value: unknown): WebhookOffReason | null {
	if (value === null) return null;
	if (!isWebhookOffReason(value)) throw new Error('Invalid stored off reason');
	return value;
}

function eventType(value: unknown): WebhookEventType {
	if (isWebhookEventType(value)) return value;
	throw new Error('Invalid stored webhook event type');
}

function storedEvents(value: unknown): SubscribableWebhookEvent[] {
	const events: unknown = JSON.parse(text(value, 'webhook events'));
	if (!Array.isArray(events)) throw new Error('Invalid stored webhook events');
	return events.map((event) => {
		if (!isSubscribableWebhookEvent(event)) throw new Error('Invalid stored webhook event');
		return event;
	});
}

function deliveryState(value: unknown): WebhookDeliveryState {
	if (value === 'pending' || value === 'succeeded' || value === 'failed' || value === 'skipped')
		return value;
	throw new Error('Invalid stored delivery state');
}

function deliveryError(value: unknown): WebhookDeliveryError | null {
	if (value === null) return null;
	const code = webhookDeliveryErrors.find((error) => error === value);
	if (!code) throw new Error('Invalid stored delivery error');
	return code;
}

const endpointColumns =
	'id, tenant_id, transport, target_key, target, off_reason, url, events, milestone_interval, enabled, secret_version, previous_secret_until, key_id, failure_count, paused_until, last_success_at, last_failure_at, expires_at, created_at, updated_at';

function toEndpoint(row: Record<string, unknown>): WebhookEndpointRow {
	return {
		id: text(row.id, 'endpoint'),
		tenantId: text(row.tenant_id, 'tenant'),
		transport: text(row.transport, 'transport'),
		targetKey: optionalText(row.target_key, 'target key'),
		target: optionalText(row.target, 'target'),
		offReason: offReason(row.off_reason),
		url: text(row.url, 'endpoint URL'),
		events: storedEvents(row.events),
		milestoneInterval: optionalCount(row.milestone_interval, 'milestone interval'),
		enabled: row.enabled === 1,
		secretVersion: count(row.secret_version, 'secret version'),
		previousSecretUntil: optionalCount(row.previous_secret_until, 'secret grace'),
		keyId: text(row.key_id, 'key ID'),
		failureCount: count(row.failure_count, 'failure count'),
		pausedUntil: optionalCount(row.paused_until, 'pause'),
		lastSuccessAt: optionalCount(row.last_success_at, 'success time'),
		lastFailureAt: optionalCount(row.last_failure_at, 'failure time'),
		expiresAt: optionalCount(row.expires_at, 'expiry time'),
		createdAt: count(row.created_at, 'creation time'),
		updatedAt: count(row.updated_at, 'update time')
	};
}

// One statement counts the http endpoints and inserts, so two creates at once cannot both take
// the last place under the limit. Endpoints of another transport do not count.
export async function createWebhookEndpoint(
	db: D1Database,
	endpoint: NewWebhookEndpoint
): Promise<CreateEndpointResult> {
	const row = await db
		.prepare(
			`INSERT INTO webhook_endpoints (id, tenant_id, url, events, milestone_interval, key_id, created_at, updated_at)
			SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7 FROM tenant_policy p WHERE p.tenant_id = ?2
			AND (SELECT COUNT(*) FROM webhook_endpoints WHERE tenant_id = ?2 AND transport = 'http') < COALESCE(p.webhook_endpoint_limit, 0)
			RETURNING ${endpointColumns}`
		)
		.bind(
			endpoint.id,
			endpoint.tenantId,
			endpoint.url,
			JSON.stringify(endpoint.events),
			endpoint.milestoneInterval,
			endpoint.keyId,
			endpoint.now
		)
		.first<Record<string, unknown>>();
	if (row) return { status: 'created', endpoint: toEndpoint(row) };
	// Nothing was written; say why. The insert above already kept the limit.
	const policy = await db
		.prepare(
			'SELECT COALESCE(webhook_endpoint_limit, 0) AS endpoint_limit FROM tenant_policy WHERE tenant_id = ?'
		)
		.bind(endpoint.tenantId)
		.first<{ endpoint_limit: unknown }>();
	if (!policy) return { status: 'no_workspace' };
	return { status: 'limit', limit: count(policy.endpoint_limit, 'webhook endpoint limit') };
}

// The tenant's endpoints of one transport, oldest first, with the number in use and the limit.
// Null when routing holds no policy for the tenant.
export async function listWebhookEndpoints(
	db: D1Database,
	tenantId: string,
	transport = httpTransport
): Promise<{ endpoints: WebhookEndpointRow[]; used: number; limit: number } | null> {
	const [policy, endpoints] = await db.batch<Record<string, unknown>>([
		db
			.prepare(
				'SELECT COALESCE(webhook_endpoint_limit, 0) AS endpoint_limit, (SELECT COUNT(*) FROM webhook_endpoints WHERE tenant_id = ?1 AND transport = ?2) AS used FROM tenant_policy WHERE tenant_id = ?1'
			)
			.bind(tenantId, transportName(transport)),
		db
			.prepare(
				`SELECT ${endpointColumns} FROM webhook_endpoints WHERE tenant_id = ? AND transport = ? ORDER BY created_at, id LIMIT 100`
			)
			.bind(tenantId, transport)
	]);
	const row = policy.results[0];
	if (!row) return null;
	return {
		endpoints: endpoints.results.map(toEndpoint),
		used: count(row.used, 'webhook endpoint count'),
		limit: count(row.endpoint_limit, 'webhook endpoint limit')
	};
}

// Null when the tenant has no such endpoint on the transport.
export async function readWebhookEndpoint(
	db: D1Database,
	tenantId: string,
	endpointId: string,
	transport = httpTransport
): Promise<WebhookEndpointRow | null> {
	const row = await db
		.prepare(
			`SELECT ${endpointColumns} FROM webhook_endpoints WHERE tenant_id = ? AND id = ? AND transport = ?`
		)
		.bind(tenantId, endpointId, transportName(transport))
		.first<Record<string, unknown>>();
	return row ? toEndpoint(row) : null;
}

// Null when the tenant has no such endpoint on the transport. The interval follows the events:
// without link.click_milestone it is cleared; with it, a missing interval keeps the stored one or
// takes the default. Turning the endpoint on or changing its URL ends a pause. Turning it on or
// off clears the reason Flared turned it off: the owner's choice replaces it.
export async function updateWebhookEndpoint(
	db: D1Database,
	tenantId: string,
	endpointId: string,
	change: WebhookEndpointChange,
	transport = httpTransport
): Promise<WebhookEndpointRow | null> {
	const restart = '(?6 = 1 AND enabled = 0) OR (?3 IS NOT NULL AND ?3 <> url)';
	const row = await db
		.prepare(
			`UPDATE webhook_endpoints SET
				url = COALESCE(?3, url),
				events = COALESCE(?4, events),
				milestone_interval = CASE
					WHEN EXISTS (SELECT 1 FROM json_each(COALESCE(?4, events)) WHERE value = 'link.click_milestone')
					THEN COALESCE(?5, milestone_interval, ?8) ELSE NULL END,
				enabled = COALESCE(?6, enabled),
				off_reason = CASE WHEN ?6 IS NULL THEN off_reason END,
				failure_count = CASE WHEN ${restart} THEN 0 ELSE failure_count END,
				paused_until = CASE WHEN ${restart} THEN NULL ELSE paused_until END,
				updated_at = ?7
			WHERE tenant_id = ?1 AND id = ?2 AND transport = ?9
			RETURNING ${endpointColumns}`
		)
		.bind(
			tenantId,
			endpointId,
			change.url ?? null,
			change.events === undefined ? null : JSON.stringify(change.events),
			change.milestoneInterval ?? null,
			change.enabled === undefined ? null : change.enabled ? 1 : 0,
			change.now,
			defaultMilestoneInterval,
			transportName(transport)
		)
		.first<Record<string, unknown>>();
	return row ? toEndpoint(row) : null;
}

// Removes the endpoint and its delivery history. Returns false when the tenant has no such
// endpoint on the transport.
export async function deleteWebhookEndpoint(
	db: D1Database,
	tenantId: string,
	endpointId: string,
	transport = httpTransport
): Promise<boolean> {
	const [, endpoint] = await db.batch([
		db
			.prepare(
				`DELETE FROM webhook_deliveries WHERE tenant_id = ?1 AND endpoint_id = ?2
				AND EXISTS (SELECT 1 FROM webhook_endpoints WHERE id = ?2 AND tenant_id = ?1 AND transport = ?3)`
			)
			.bind(tenantId, endpointId, transportName(transport)),
		db
			.prepare('DELETE FROM webhook_endpoints WHERE tenant_id = ? AND id = ? AND transport = ?')
			.bind(tenantId, endpointId, transport)
	]);
	return endpoint.meta.changes === 1;
}

// Moves to the next secret version under the current deployment key. The previous secret keeps
// signing until previousUntil, unless it came from another key and cannot be derived any more.
export async function rotateWebhookSecret(
	db: D1Database,
	tenantId: string,
	endpointId: string,
	rotation: { keyId: string; now: number; previousUntil: number },
	transport = httpTransport
): Promise<WebhookEndpointRow | null> {
	const row = await db
		.prepare(
			`UPDATE webhook_endpoints SET secret_version = secret_version + 1,
				previous_secret_until = CASE WHEN key_id = ?3 THEN ?5 ELSE NULL END,
				key_id = ?3, updated_at = ?4
			WHERE tenant_id = ?1 AND id = ?2 AND transport = ?6
			RETURNING ${endpointColumns}`
		)
		.bind(
			tenantId,
			endpointId,
			rotation.keyId,
			rotation.now,
			rotation.previousUntil,
			transportName(transport)
		)
		.first<Record<string, unknown>>();
	return row ? toEndpoint(row) : null;
}

// The interval a transport endpoint keeps: only with link.click_milestone, the default when
// none is given.
function transportInterval(
	events: readonly SubscribableWebhookEvent[],
	interval: number | null
): number | null {
	if (!events.includes('link.click_milestone')) return null;
	const value = interval ?? defaultMilestoneInterval;
	if (
		!Number.isSafeInteger(value) ||
		value < minMilestoneInterval ||
		value > maxMilestoneInterval ||
		value % milestoneStep !== 0
	)
		throw new Error('Invalid milestone interval');
	return value;
}

function transportEvents(events: readonly unknown[]): SubscribableWebhookEvent[] {
	if (!events.every(isSubscribableWebhookEvent)) throw new Error('Invalid webhook events');
	return [...new Set(events)];
}

// One statement checks the plan, counts the workspace's endpoints on the transport, and inserts,
// so two creates at once cannot both take the last place under the limit or the same target key.
// Only when nothing is written, a second read says why.
export async function createTransportEndpoint(
	db: D1Database,
	endpoint: NewTransportEndpoint
): Promise<CreateTransportEndpointResult> {
	const transport = otherTransport(endpoint.transport);
	const key = targetKey(endpoint.targetKey);
	if (endpoint.target !== null && endpoint.target.length > 2048)
		throw new Error('Invalid webhook target');
	const events = transportEvents(endpoint.events);
	const limit = batchSize(endpoint.limit, 1000);
	const row = await db
		.prepare(
			`INSERT INTO webhook_endpoints (id, tenant_id, transport, target_key, target, url, events, milestone_interval, key_id, created_at, updated_at)
			SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10 FROM tenant_policy p WHERE p.tenant_id = ?2
			AND COALESCE(p.webhook_endpoint_limit, 0) > 0
			AND (SELECT COUNT(*) FROM webhook_endpoints WHERE tenant_id = ?2 AND transport = ?3) < ?11
			ON CONFLICT(tenant_id, transport, target_key) WHERE target_key IS NOT NULL DO NOTHING
			RETURNING ${endpointColumns}`
		)
		.bind(
			endpoint.id,
			endpoint.tenantId,
			transport,
			key,
			endpoint.target,
			endpoint.url,
			JSON.stringify(events),
			transportInterval(events, endpoint.milestoneInterval),
			transportKeyId,
			endpoint.now,
			limit
		)
		.first<Record<string, unknown>>();
	if (row) return { status: 'created', endpoint: toEndpoint(row) };
	const policy = await db
		.prepare(
			`SELECT COALESCE(webhook_endpoint_limit, 0) AS endpoint_limit,
				EXISTS (SELECT 1 FROM webhook_endpoints WHERE tenant_id = ?1 AND transport = ?2 AND target_key = ?3) AS taken
			FROM tenant_policy WHERE tenant_id = ?1`
		)
		.bind(endpoint.tenantId, transport, key)
		.first<Record<string, unknown>>();
	if (!policy) return { status: 'no_workspace' };
	if (count(policy.endpoint_limit, 'webhook endpoint limit') === 0)
		return { status: 'limit', limit: 0 };
	if (policy.taken === 1) return { status: 'taken' };
	return { status: 'limit', limit };
}

// The tenant's endpoints on a transport other than http, in target key order, at most limit.
// keyPrefix keeps the keys that start with it; after is the last target key of the previous page.
export async function listTransportEndpoints(
	db: D1Database,
	options: {
		transport: string;
		tenantId: string;
		keyPrefix?: string;
		after?: string;
		limit: number;
	}
): Promise<WebhookEndpointRow[]> {
	const values: (string | number)[] = [
		otherTransport(options.transport),
		options.tenantId,
		batchSize(options.limit, 100)
	];
	const bound = (value: string | number) => `?${values.push(value)}`;
	const conditions = [
		options.keyPrefix === undefined
			? ''
			: ` AND substr(target_key, 1, ${bound(targetKey(options.keyPrefix).length)}) = ${bound(options.keyPrefix)}`,
		options.after === undefined ? '' : ` AND target_key > ${bound(options.after)}`
	].join('');
	const { results } = await db
		.prepare(
			`SELECT ${endpointColumns} FROM webhook_endpoints
			WHERE transport = ?1 AND tenant_id = ?2 AND target_key IS NOT NULL${conditions}
			ORDER BY target_key LIMIT ?3`
		)
		.bind(...values)
		.all<Record<string, unknown>>();
	return results.map(toEndpoint);
}

// Endpoints of a transport other than http by ID, across workspaces, with each workspace's
// analytics shard and whether it has webhooks on, for a scheduled job. IDs not found are left out.
export async function readTransportEndpoints(
	db: D1Database,
	ids: readonly string[]
): Promise<TransportEndpointState[]> {
	if (ids.length === 0) return [];
	batchSize(ids.length, 100);
	const columns = endpointColumns
		.split(', ')
		.map((column) => `w.${column}`)
		.join(', ');
	const { results } = await db
		.prepare(
			`SELECT ${columns}, p.analytics_shard_id,
				(COALESCE(p.webhook_endpoint_limit, 0) > 0 AND p.suspended_at IS NULL) AS workspace_on
			FROM json_each(?1) j
			JOIN webhook_endpoints w ON w.id = j.value AND w.transport <> 'http'
			JOIN tenant_policy p ON p.tenant_id = w.tenant_id`
		)
		.bind(JSON.stringify(ids))
		.all<Record<string, unknown>>();
	return results.map((row) => ({
		...toEndpoint(row),
		analyticsShardId: text(row.analytics_shard_id, 'analytics shard'),
		on: row.workspace_on === 1
	}));
}

// Changes an endpoint of a transport other than http as updateWebhookEndpoint does: turning it
// on clears its off reason and its pause. Its url and target stay. Null when the tenant has no
// such endpoint on the transport.
export async function updateTransportEndpoint(
	db: D1Database,
	tenantId: string,
	transport: string,
	endpointId: string,
	change: Omit<WebhookEndpointChange, 'url'>
): Promise<WebhookEndpointRow | null> {
	if (change.milestoneInterval !== undefined)
		transportInterval(['link.click_milestone'], change.milestoneInterval);
	return updateWebhookEndpoint(
		db,
		tenantId,
		endpointId,
		{
			events: change.events === undefined ? undefined : transportEvents(change.events),
			milestoneInterval: change.milestoneInterval,
			enabled: change.enabled,
			now: change.now
		},
		otherTransport(transport)
	);
}

export interface TransportTargetChange {
	targetKey: string;
	target: string | null;
	url: string;
	now: number;
}

// Points an endpoint of a transport other than http at a new target, such as a renamed or
// replaced channel link, and keeps its ID, so automations that post to it keep working. An
// endpoint that Flared turned off as target_unavailable turns on again with no pause when its
// target key changes, because a new key names a new target; with the same key (a rename) it
// stays off. One the owner turned off stays off. Null when the tenant has no such endpoint on the transport; taken
// when another of its endpoints on the transport has the target key.
export async function updateTransportTarget(
	db: D1Database,
	tenantId: string,
	transport: string,
	endpointId: string,
	change: TransportTargetChange
): Promise<WebhookEndpointRow | 'taken' | null> {
	const name = otherTransport(transport);
	const key = targetKey(change.targetKey);
	if (change.target !== null && change.target.length > 2048)
		throw new Error('Invalid webhook target');
	// OR IGNORE: a key another endpoint holds writes nothing, and the read below tells why.
	const row = await db
		.prepare(
			`UPDATE OR IGNORE webhook_endpoints SET target_key = ?4, target = ?5, url = ?6, updated_at = ?7,
				enabled = CASE WHEN off_reason = 'target_unavailable' AND target_key <> ?4 THEN 1 ELSE enabled END,
				failure_count = CASE WHEN off_reason = 'target_unavailable' AND target_key <> ?4 THEN 0 ELSE failure_count END,
				paused_until = CASE WHEN off_reason = 'target_unavailable' AND target_key <> ?4 THEN NULL ELSE paused_until END,
				off_reason = CASE WHEN off_reason = 'target_unavailable' AND target_key <> ?4 THEN NULL ELSE off_reason END
			WHERE tenant_id = ?1 AND id = ?2 AND transport = ?3
			RETURNING ${endpointColumns}`
		)
		.bind(tenantId, endpointId, name, key, change.target, change.url, change.now)
		.first<Record<string, unknown>>();
	if (row) return toEndpoint(row);
	const found = await db
		.prepare('SELECT 1 FROM webhook_endpoints WHERE tenant_id = ?1 AND id = ?2 AND transport = ?3')
		.bind(tenantId, endpointId, name)
		.first();
	return found ? 'taken' : null;
}

// Removes one endpoint of a transport other than http (with endpointId) or all of the tenant's
// on that transport, deliveries first. Returns the endpoints removed.
export async function deleteTransportEndpoints(
	db: D1Database,
	tenantId: string,
	transport: string,
	endpointId?: string
): Promise<number> {
	const values = [tenantId, otherTransport(transport)];
	const only = endpointId === undefined ? '' : ` AND id = ?${values.push(endpointId)}`;
	const [, endpoints] = await db.batch([
		db
			.prepare(
				`DELETE FROM webhook_deliveries WHERE tenant_id = ?1 AND endpoint_id IN
				(SELECT id FROM webhook_endpoints WHERE tenant_id = ?1 AND transport = ?2${only})`
			)
			.bind(...values),
		db
			.prepare(`DELETE FROM webhook_endpoints WHERE tenant_id = ?1 AND transport = ?2${only}`)
			.bind(...values)
	]);
	return endpoints.meta.changes;
}

// Turns on again the tenant's endpoints on a transport other than http that Flared turned off
// as unauthorized, after the workspace connects again. Endpoints the owner turned off, or turned
// off for target_unavailable, stay off. Returns the endpoints turned on.
export async function restoreTransportEndpoints(
	db: D1Database,
	tenantId: string,
	transport: string,
	now: number
): Promise<number> {
	const result = await db
		.prepare(
			`UPDATE webhook_endpoints SET enabled = 1, off_reason = NULL, failure_count = 0, paused_until = NULL, updated_at = ?3
			WHERE tenant_id = ?1 AND transport = ?2 AND off_reason = 'unauthorized'`
		)
		.bind(tenantId, otherTransport(transport), now)
		.run();
	return result.meta.changes;
}

// The transport of REST hooks: endpoints that a client such as Zapier subscribes through the API,
// one event each, until expires_at.
export const hookTransport = 'resthook';
// Live hooks a workspace may hold. The webhook endpoint limit does not count them.
export const maxHooksPerWorkspace = 50;

// Who subscribed a hook and with which credential: token:<id>, oauth:<clientId>, or session. A
// hook is deleted when its maker leaves the workspace or the credential is revoked.
export interface HookMaker {
	userId: string;
	credential: string;
}

export interface NewHook {
	id: string;
	tenantId: string;
	event: SubscribableWebhookEvent;
	targetUrl: string;
	milestoneInterval: number | null;
	maker: HookMaker;
	now: number;
	expiresAt: number;
}

// limit: 0 while the workspace has webhooks off, else the hook cap.
export type SubscribeHookResult =
	| { status: 'created'; endpoint: WebhookEndpointRow }
	| { status: 'limit'; limit: number }
	| { status: 'no_workspace' };

// The target key of a hook: one per workspace, maker, event, and target URL.
async function hookKey(userId: string, event: string, targetUrl: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(JSON.stringify([userId, event, targetUrl]))
	);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

// One batch deletes the maker's hook with the same event and target URL while the workspace
// has webhooks on, then checks the plan, counts the live hooks, and inserts. A client that
// subscribes again, before or after it unsubscribes the old hook, so never holds two hooks that
// send the same event to one URL. Only when nothing is written, a second read says why.
export async function subscribeHook(db: D1Database, hook: NewHook): Promise<SubscribeHookResult> {
	const events = transportEvents([hook.event]);
	const key = await hookKey(hook.maker.userId, hook.event, hook.targetUrl);
	const hooksOn = `EXISTS (SELECT 1 FROM tenant_policy WHERE tenant_id = ?1 AND COALESCE(webhook_endpoint_limit, 0) > 0)`;
	const [, , inserted] = await db.batch<Record<string, unknown>>([
		db
			.prepare(
				`DELETE FROM webhook_deliveries WHERE tenant_id = ?1 AND endpoint_id IN
				(SELECT id FROM webhook_endpoints WHERE tenant_id = ?1 AND transport = ?2 AND target_key = ?3)
				AND ${hooksOn}`
			)
			.bind(hook.tenantId, hookTransport, key),
		db
			.prepare(
				`DELETE FROM webhook_endpoints WHERE tenant_id = ?1 AND transport = ?2 AND target_key = ?3
				AND ${hooksOn}`
			)
			.bind(hook.tenantId, hookTransport, key),
		db
			.prepare(
				`INSERT INTO webhook_endpoints (id, tenant_id, transport, target_key, target, url, events, milestone_interval, key_id, expires_at, created_at, updated_at)
				SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11 FROM tenant_policy p WHERE p.tenant_id = ?2
				AND COALESCE(p.webhook_endpoint_limit, 0) > 0
				AND (SELECT COUNT(*) FROM webhook_endpoints WHERE tenant_id = ?2 AND transport = ?3 AND expires_at > ?11) < ?12
				RETURNING ${endpointColumns}`
			)
			.bind(
				hook.id,
				hook.tenantId,
				hookTransport,
				key,
				JSON.stringify({ userId: hook.maker.userId, credential: hook.maker.credential }),
				hook.targetUrl,
				JSON.stringify(events),
				transportInterval(events, hook.milestoneInterval),
				transportKeyId,
				hook.expiresAt,
				hook.now,
				maxHooksPerWorkspace
			)
	]);
	const row = inserted.results[0];
	if (row) return { status: 'created', endpoint: toEndpoint(row) };
	const policy = await db
		.prepare(
			'SELECT COALESCE(webhook_endpoint_limit, 0) AS endpoint_limit FROM tenant_policy WHERE tenant_id = ?'
		)
		.bind(hook.tenantId)
		.first<{ endpoint_limit: unknown }>();
	if (!policy) return { status: 'no_workspace' };
	if (count(policy.endpoint_limit, 'webhook endpoint limit') === 0)
		return { status: 'limit', limit: 0 };
	return { status: 'limit', limit: maxHooksPerWorkspace };
}

// Which of the workspace's hooks to delete: one hook (of one maker, with userId), or every hook of
// a maker (made with one credential, with credential).
export type HookMatch =
	{ hookId: string; userId?: string } | { userId: string; credential?: string };

// Deletes the workspace's matching hooks, deliveries first. Returns the hooks deleted.
export async function deleteHooks(
	db: D1Database,
	tenantId: string,
	match: HookMatch
): Promise<number> {
	const values: string[] = [tenantId, hookTransport];
	const bound = (value: string) => `?${values.push(value)}`;
	const conditions = [
		'hookId' in match ? ` AND id = ${bound(match.hookId)}` : '',
		match.userId === undefined
			? ''
			: ` AND json_extract(target, '$.userId') = ${bound(match.userId)}`,
		'credential' in match && match.credential !== undefined
			? ` AND json_extract(target, '$.credential') = ${bound(match.credential)}`
			: ''
	].join('');
	const [, endpoints] = await db.batch([
		db
			.prepare(
				`DELETE FROM webhook_deliveries WHERE tenant_id = ?1 AND endpoint_id IN
				(SELECT id FROM webhook_endpoints WHERE tenant_id = ?1 AND transport = ?2${conditions})`
			)
			.bind(...values),
		db
			.prepare(`DELETE FROM webhook_endpoints WHERE tenant_id = ?1 AND transport = ?2${conditions}`)
			.bind(...values)
	]);
	return endpoints.meta.changes;
}

// Deletes at most limit hooks that have ended: past expires_at, or turned off because the
// receiver said the subscription is gone. Deliveries first. Returns the hooks deleted.
export async function deleteEndedHooks(
	db: D1Database,
	now: number,
	limit: number
): Promise<number> {
	const ended = `SELECT id FROM webhook_endpoints WHERE transport = ?1
		AND (expires_at <= ?2 OR (enabled = 0 AND off_reason = 'target_unavailable'))
		ORDER BY id LIMIT ?3`;
	const values = [hookTransport, now, batchSize(limit, 1000)];
	const [, endpoints] = await db.batch([
		db.prepare(`DELETE FROM webhook_deliveries WHERE endpoint_id IN (${ended})`).bind(...values),
		db.prepare(`DELETE FROM webhook_endpoints WHERE id IN (${ended})`).bind(...values)
	]);
	return endpoints.meta.changes;
}

function toEvent(row: Record<string, unknown>): WebhookEventRow {
	return {
		id: text(row.id, 'event'),
		tenantId: text(row.tenant_id, 'tenant'),
		type: eventType(row.type),
		subjectId: optionalText(row.subject_id, 'subject'),
		targetEndpointId: optionalText(row.target_endpoint_id, 'target endpoint'),
		payload: text(row.payload, 'payload'),
		createdAt: count(row.created_at, 'event time'),
		fannedOutAt: optionalCount(row.fanned_out_at, 'fan-out time')
	};
}

// The tenant's newest events first.
export async function listWebhookEvents(
	db: D1Database,
	tenantId: string,
	limit: number
): Promise<WebhookEventRow[]> {
	const { results } = await db
		.prepare(
			'SELECT id, tenant_id, type, subject_id, target_endpoint_id, payload, created_at, fanned_out_at FROM webhook_events WHERE tenant_id = ? ORDER BY created_at DESC, id DESC LIMIT ?'
		)
		.bind(tenantId, batchSize(limit, 100))
		.all<Record<string, unknown>>();
	return results.map(toEvent);
}

// A test event for one endpoint of the tenant on the transport (http unless given), enabled or
// not. Returns false when the tenant has no such endpoint.
export async function insertTestEvent(
	db: D1Database,
	event: {
		id: string;
		tenantId: string;
		endpointId: string;
		payload: string;
		now: number;
		transport?: string;
	}
): Promise<boolean> {
	const result = await db
		.prepare(
			`INSERT INTO webhook_events (id, tenant_id, type, target_endpoint_id, payload, created_at)
			SELECT ?1, ?2, 'webhook.test', ?3, ?4, ?5 FROM webhook_endpoints WHERE id = ?3 AND tenant_id = ?2 AND transport = ?6`
		)
		.bind(
			event.id,
			event.tenantId,
			event.endpointId,
			event.payload,
			event.now,
			transportName(event.transport ?? httpTransport)
		)
		.run();
	return result.meta.changes === 1;
}

// Writes an integration.message event for each message whose endpoint is of a transport other
// than http, enabled, and in a workspace that has webhooks on and is not suspended; the others are
// dropped. An event ID already written is left alone, so a repeat stages nothing twice. Returns
// the events written.
export async function stageIntegrationMessages(
	db: D1Database,
	messages: readonly IntegrationMessage[]
): Promise<number> {
	if (messages.length === 0) return 0;
	batchSize(messages.length, maxIntegrationMessages);
	for (const message of messages)
		if (message.payload.length > 65536) throw new Error('Invalid integration message payload');
	const result = await db
		.prepare(
			`INSERT INTO webhook_events (id, tenant_id, type, target_endpoint_id, payload, created_at)
			SELECT m.id, m.tenant_id, 'integration.message', w.id, m.payload, m.created_at
			FROM (SELECT json_extract(value, '$.id') AS id, json_extract(value, '$.tenantId') AS tenant_id,
				json_extract(value, '$.endpointId') AS endpoint_id, json_extract(value, '$.payload') AS payload,
				json_extract(value, '$.createdAt') AS created_at FROM json_each(?1)) AS m
			JOIN webhook_endpoints w ON w.id = m.endpoint_id AND w.tenant_id = m.tenant_id
				AND w.transport <> 'http' AND w.enabled = 1
			JOIN tenant_policy p ON p.tenant_id = m.tenant_id
			WHERE COALESCE(p.webhook_endpoint_limit, 0) > 0 AND p.suspended_at IS NULL
			ON CONFLICT(id) DO NOTHING`
		)
		.bind(
			JSON.stringify(
				messages.map(({ id, tenantId, endpointId, payload, createdAt }) => ({
					id,
					tenantId,
					endpointId,
					payload,
					createdAt
				}))
			)
		)
		.run();
	return result.meta.changes;
}

// Turns the oldest events not fanned out yet into deliveries, in one batch: first, pending
// deliveries of a workspace whose limit is now 0 are skipped. An event goes to each enabled
// endpoint of its workspace that existed when it happened and subscribes to its type (for a
// milestone, with an interval that divides the clicks), or only to its target: a test to the
// target enabled or not, an automation event or an integration message only while the target is
// enabled, and an integration message never to an http endpoint. Nothing goes to a
// workspace at limit 0 or suspended, or to a hook that had expired when the event happened.
// The same ordered set is marked in the same batch, and a
// pair that already has a delivery is left alone, so a repeat creates no second delivery.
// With tenantId, only that workspace's events and deliveries.
export async function fanOutWebhookEvents(
	db: D1Database,
	options: { now: number; limit: number; tenantId?: string }
): Promise<{ events: number; deliveries: number; skipped: number }> {
	const values: (string | number)[] = [options.now, batchSize(options.limit, 100)];
	if (options.tenantId !== undefined) values.push(options.tenantId);
	const only = (column: string) => (options.tenantId === undefined ? '' : ` AND ${column} = ?3`);
	const pending = `SELECT id, tenant_id, type, target_endpoint_id, payload, created_at FROM webhook_events
		WHERE fanned_out_at IS NULL${only('tenant_id')} ORDER BY created_at, id LIMIT ?2`;
	const [skipped, deliveries, events] = await db.batch([
		db
			.prepare(
				`UPDATE webhook_deliveries SET state = 'skipped', error_code = 'plan', completed_at = ?1
				WHERE id IN (SELECT d.id FROM webhook_deliveries d LEFT JOIN tenant_policy p ON p.tenant_id = d.tenant_id
					WHERE d.state = 'pending' AND COALESCE(p.webhook_endpoint_limit, 0) = 0${only('d.tenant_id')}
					ORDER BY d.next_attempt_at, d.id LIMIT ?2)`
			)
			.bind(...values),
		db
			.prepare(
				`INSERT INTO webhook_deliveries (id, tenant_id, event_id, endpoint_id, next_attempt_at, created_at)
				SELECT 'dlv_' || lower(hex(randomblob(16))), e.tenant_id, e.id, w.id, ?1, ?1
				FROM (${pending}) e
				JOIN tenant_policy p ON p.tenant_id = e.tenant_id
				JOIN webhook_endpoints w ON w.tenant_id = e.tenant_id
				WHERE COALESCE(p.webhook_endpoint_limit, 0) > 0 AND p.suspended_at IS NULL
				AND (w.expires_at IS NULL OR w.expires_at > e.created_at)
				AND ((w.id = e.target_endpoint_id AND (w.enabled = 1 OR e.type = 'webhook.test')
					AND (e.type <> 'integration.message' OR w.transport <> 'http')) OR (
					e.target_endpoint_id IS NULL AND w.enabled = 1 AND w.created_at <= e.created_at
					AND EXISTS (SELECT 1 FROM json_each(w.events) WHERE value = e.type)
					AND (e.type <> 'link.click_milestone' OR json_extract(e.payload, '$.clicks') % w.milestone_interval = 0)
				))
				ON CONFLICT(event_id, endpoint_id) DO NOTHING`
			)
			.bind(...values),
		db
			.prepare(
				`UPDATE webhook_events SET fanned_out_at = ?1 WHERE id IN (SELECT id FROM (${pending}))`
			)
			.bind(...values)
	]);
	return {
		events: events.meta.changes,
		deliveries: deliveries.meta.changes,
		skipped: skipped.meta.changes
	};
}

// Claims due deliveries in one statement, so two runs at once claim different ones. A claim is
// an attempt: the next one is due after a backoff of 1 minute doubling up to 512 minutes, so a
// run that stops before it finishes leaves the delivery for a later run. Deliveries to a paused
// endpoint wait. With tenantId, only that workspace's; with untriedOnly, only deliveries never
// tried. With eventId, only that event's, paused endpoint or not: a test send was asked for.
export async function claimWebhookDeliveries(
	db: D1Database,
	options: {
		now: number;
		limit: number;
		tenantId?: string;
		untriedOnly?: boolean;
		eventId?: string;
	}
): Promise<string[]> {
	const values: (string | number)[] = [options.now, batchSize(options.limit, 100)];
	const bound = (value: string) => `?${values.push(value)}`;
	const conditions = [
		options.tenantId === undefined ? '' : ` AND d.tenant_id = ${bound(options.tenantId)}`,
		options.eventId === undefined
			? ' AND (w.paused_until IS NULL OR w.paused_until <= ?1)'
			: ` AND d.event_id = ${bound(options.eventId)}`,
		options.untriedOnly ? ' AND d.attempts = 0' : ''
	].join('');
	const { results } = await db
		.prepare(
			`UPDATE webhook_deliveries SET attempts = attempts + 1,
				next_attempt_at = ?1 + (60000 << min(attempts, 9)), last_attempt_at = ?1
			WHERE id IN (SELECT d.id FROM webhook_deliveries d
				JOIN webhook_endpoints w ON w.id = d.endpoint_id
				JOIN tenant_policy p ON p.tenant_id = d.tenant_id
				WHERE d.state = 'pending' AND d.next_attempt_at <= ?1 AND d.attempts < ${webhookMaxAttempts}
				AND COALESCE(p.webhook_endpoint_limit, 0) > 0 AND p.suspended_at IS NULL${conditions}
				ORDER BY d.next_attempt_at, d.id LIMIT ?2)
			RETURNING id`
		)
		.bind(...values)
		.all<{ id: unknown }>();
	return results.map((row) => text(row.id, 'delivery'));
}

// The claimed deliveries with their event and endpoint, oldest event first.
export async function readClaimedDeliveries(
	db: D1Database,
	ids: string[]
): Promise<ClaimedDelivery[]> {
	if (ids.length === 0) return [];
	batchSize(ids.length, 100);
	const { results } = await db
		.prepare(
			`SELECT d.id, d.tenant_id, d.attempts, e.id AS event_id, e.type, e.payload, e.created_at AS event_created_at,
				e.target_endpoint_id, w.id AS endpoint_id, w.transport, w.target, w.url, w.enabled, w.secret_version,
				w.previous_secret_until, w.key_id
			FROM json_each(?1) j
			JOIN webhook_deliveries d ON d.id = j.value
			JOIN webhook_events e ON e.id = d.event_id
			JOIN webhook_endpoints w ON w.id = d.endpoint_id
			ORDER BY e.created_at, e.id`
		)
		.bind(JSON.stringify(ids))
		.all<Record<string, unknown>>();
	return results.map((row) => ({
		id: text(row.id, 'delivery'),
		tenantId: text(row.tenant_id, 'tenant'),
		attempts: count(row.attempts, 'attempts'),
		event: {
			id: text(row.event_id, 'event'),
			type: eventType(row.type),
			payload: text(row.payload, 'payload'),
			createdAt: count(row.event_created_at, 'event time'),
			targeted: row.target_endpoint_id !== null
		},
		endpoint: {
			id: text(row.endpoint_id, 'endpoint'),
			transport: text(row.transport, 'transport'),
			target: optionalText(row.target, 'target'),
			url: text(row.url, 'endpoint URL'),
			enabled: row.enabled === 1,
			secretVersion: count(row.secret_version, 'secret version'),
			previousSecretUntil: optionalCount(row.previous_secret_until, 'secret grace'),
			keyId: text(row.key_id, 'key ID')
		}
	}));
}

// Failures that come from the receiver count against its endpoint. rate_limited does not: the
// transport asked to wait, and the delivery retries without a pause.
const receiverErrors = new Set<WebhookDeliveryError>([
	'timeout',
	'network',
	'redirect',
	'http_status'
]);

// Records the results of a run in one batch: one statement for the deliveries, one for the
// endpoints' health, and one for off reasons when a result has one. A receiver failure pauses
// its endpoint for 1 minute doubling with each failing run, up to 512 minutes; a success in the
// run ends the pause. A failed target_unavailable turns that endpoint off; a failed unauthorized
// turns off every enabled endpoint of the workspace on that transport. http endpoints keep on.
export async function finishWebhookDeliveries(
	db: D1Database,
	results: DeliveryResult[],
	now: number
): Promise<void> {
	if (results.length === 0) return;
	const health = new Map<string, { endpointId: string; succeeded: number; failed: number }>();
	// unauthorized wins: it turns off the endpoint too.
	const offReasons = new Map<string, WebhookOffReason>();
	for (const result of results) {
		if (
			result.outcome === 'failed' &&
			(result.errorCode === 'unauthorized' || result.errorCode === 'target_unavailable') &&
			offReasons.get(result.endpointId) !== 'unauthorized'
		)
			offReasons.set(result.endpointId, result.errorCode);
	}
	for (const result of results) {
		const succeeded = result.outcome === 'succeeded';
		const failed = result.errorCode !== null && receiverErrors.has(result.errorCode);
		if (!succeeded && !failed) continue;
		const entry = health.get(result.endpointId) ?? {
			endpointId: result.endpointId,
			succeeded: 0,
			failed: 0
		};
		if (succeeded) entry.succeeded = 1;
		if (failed) entry.failed = 1;
		health.set(result.endpointId, entry);
	}
	const state = `CASE r.outcome WHEN 'retry' THEN CASE WHEN webhook_deliveries.attempts >= ?2 THEN 'failed' ELSE 'pending' END ELSE r.outcome END`;
	const statements = [
		db
			.prepare(
				`UPDATE webhook_deliveries SET state = ${state},
					response_status = r.response_status, error_code = r.error_code, duration_ms = r.duration_ms,
					completed_at = CASE WHEN ${state} = 'pending' THEN NULL ELSE ?1 END
				FROM (SELECT json_extract(value, '$.id') AS id, json_extract(value, '$.outcome') AS outcome,
					json_extract(value, '$.responseStatus') AS response_status, json_extract(value, '$.errorCode') AS error_code,
					json_extract(value, '$.durationMs') AS duration_ms FROM json_each(?3)) AS r
				WHERE webhook_deliveries.id = r.id AND webhook_deliveries.state = 'pending'`
			)
			.bind(
				now,
				webhookMaxAttempts,
				JSON.stringify(
					results.map(({ id, outcome, responseStatus, errorCode, durationMs }) => ({
						id,
						outcome,
						responseStatus,
						errorCode,
						durationMs
					}))
				)
			)
	];
	if (health.size > 0)
		statements.push(
			db
				.prepare(
					`UPDATE webhook_endpoints SET
						failure_count = CASE WHEN h.succeeded = 1 THEN 0 ELSE failure_count + 1 END,
						paused_until = CASE WHEN h.succeeded = 1 THEN NULL ELSE ?1 + (60000 << min(failure_count, 9)) END,
						last_success_at = CASE WHEN h.succeeded = 1 THEN ?1 ELSE last_success_at END,
						last_failure_at = CASE WHEN h.failed = 1 THEN ?1 ELSE last_failure_at END
					FROM (SELECT json_extract(value, '$.endpointId') AS endpoint_id, json_extract(value, '$.succeeded') AS succeeded,
						json_extract(value, '$.failed') AS failed FROM json_each(?2)) AS h
					WHERE webhook_endpoints.id = h.endpoint_id`
				)
				.bind(now, JSON.stringify([...health.values()]))
		);
	if (offReasons.size > 0)
		statements.push(
			db
				.prepare(
					`UPDATE webhook_endpoints SET enabled = 0, off_reason = r.reason, updated_at = ?1
					FROM (SELECT json_extract(value, '$.endpointId') AS endpoint_id, json_extract(value, '$.reason') AS reason
						FROM json_each(?2)) AS r
					WHERE webhook_endpoints.enabled = 1 AND webhook_endpoints.transport <> 'http' AND (
						(r.reason = 'target_unavailable' AND webhook_endpoints.id = r.endpoint_id)
						OR (r.reason = 'unauthorized' AND (webhook_endpoints.tenant_id, webhook_endpoints.transport) =
							(SELECT o.tenant_id, o.transport FROM webhook_endpoints o WHERE o.id = r.endpoint_id)))`
				)
				.bind(
					now,
					JSON.stringify([...offReasons].map(([endpointId, reason]) => ({ endpointId, reason })))
				)
		);
	await db.batch(statements);
}

// Click milestones waiting on an analytics shard, oldest first.
export async function readClickMilestones(
	shard: D1Database,
	limit: number
): Promise<ClickMilestone[]> {
	const { results } = await shard
		.prepare(
			'SELECT id, tenant_id, link_id, clicks, created_at FROM click_milestones ORDER BY created_at, id LIMIT ?'
		)
		.bind(batchSize(limit, 100))
		.all<Record<string, unknown>>();
	return results.map((row) => ({
		id: text(row.id, 'milestone'),
		tenantId: text(row.tenant_id, 'tenant'),
		linkId: text(row.link_id, 'link'),
		clicks: count(row.clicks, 'clicks'),
		createdAt: count(row.created_at, 'milestone time')
	}));
}

// Writes a link.click_milestone event for each milestone that an enabled endpoint of the
// workspace subscribes to with an interval that divides the clicks; the others are dropped. The
// link is read now. The event ID is the milestone ID, so a repeat after a run that stopped
// before deleting the milestones writes nothing twice. Returns the events written.
export async function insertMilestoneEvents(
	routing: D1Database,
	milestones: ClickMilestone[]
): Promise<number> {
	if (milestones.length === 0) return 0;
	const result = await milestoneEventsStatement(routing, milestones).run();
	return result.meta.changes;
}

// The statement of insertMilestoneEvents, for a caller that batches it with other milestone
// work, such as markClickApplications. milestones must not be empty.
export function milestoneEventsStatement(
	routing: D1Database,
	milestones: ClickMilestone[]
): D1PreparedStatement {
	batchSize(milestones.length, 100);
	return routing
		.prepare(
			`INSERT INTO webhook_events (id, tenant_id, type, subject_id, payload, created_at)
			SELECT m.id, m.tenant_id, 'link.click_milestone', m.link_id, json_object('link', ${linkJson('l', 'n')}, 'clicks', m.clicks), m.created_at
			FROM (SELECT json_extract(value, '$.id') AS id, json_extract(value, '$.tenantId') AS tenant_id,
				json_extract(value, '$.linkId') AS link_id, json_extract(value, '$.clicks') AS clicks,
				json_extract(value, '$.createdAt') AS created_at FROM json_each(?1)) AS m
			JOIN links l ON l.id = m.link_id AND l.tenant_id = m.tenant_id
			JOIN domain_namespaces n ON n.id = l.domain_id
			JOIN tenant_policy p ON p.tenant_id = m.tenant_id
			WHERE COALESCE(p.webhook_endpoint_limit, 0) > 0 AND p.suspended_at IS NULL
			AND EXISTS (SELECT 1 FROM webhook_endpoints w WHERE w.tenant_id = m.tenant_id AND w.enabled = 1
				AND m.clicks % w.milestone_interval = 0
				AND EXISTS (SELECT 1 FROM json_each(w.events) WHERE value = 'link.click_milestone'))
			ON CONFLICT(id) DO NOTHING`
		)
		.bind(JSON.stringify(milestones));
}

// Deletes milestones from a shard once routing holds their events.
export async function deleteClickMilestones(shard: D1Database, ids: string[]): Promise<number> {
	if (ids.length === 0) return 0;
	batchSize(ids.length, 100);
	const result = await shard
		.prepare('DELETE FROM click_milestones WHERE id IN (SELECT value FROM json_each(?))')
		.bind(JSON.stringify(ids))
		.run();
	return result.meta.changes;
}

// Fails deliveries still pending after webhookDeliveryLifetimeMs, oldest first.
export async function expireWebhookDeliveries(
	db: D1Database,
	now: number,
	limit: number
): Promise<number> {
	const result = await db
		.prepare(
			`UPDATE webhook_deliveries SET state = 'failed', error_code = 'expired', completed_at = ?1
			WHERE id IN (SELECT id FROM webhook_deliveries WHERE state = 'pending' AND created_at < ?2 ORDER BY created_at LIMIT ?3)`
		)
		.bind(now, now - webhookDeliveryLifetimeMs, batchSize(limit, 1000))
		.run();
	return result.meta.changes;
}

// Deletes deliveries older than webhookRecordLifetimeMs, then events as old with no delivery
// left, so no cascade deletes more than limit rows. Returns the rows deleted.
export async function deleteOldWebhookRecords(
	db: D1Database,
	now: number,
	limit: number
): Promise<number> {
	const cutoff = now - webhookRecordLifetimeMs;
	const size = batchSize(limit, 1000);
	const results = await db.batch([
		db
			.prepare(
				'DELETE FROM webhook_deliveries WHERE id IN (SELECT id FROM webhook_deliveries WHERE created_at < ? ORDER BY created_at LIMIT ?)'
			)
			.bind(cutoff, size),
		db
			.prepare(
				'DELETE FROM webhook_events WHERE id IN (SELECT e.id FROM webhook_events e WHERE e.created_at < ? AND NOT EXISTS (SELECT 1 FROM webhook_deliveries d WHERE d.event_id = e.id) ORDER BY e.created_at LIMIT ?)'
			)
			.bind(cutoff, size)
	]);
	return results.reduce((sum, result) => sum + result.meta.changes, 0);
}

// The endpoint's newest deliveries first. Empty when the tenant has no such endpoint on the
// transport.
export async function listEndpointDeliveries(
	db: D1Database,
	tenantId: string,
	endpointId: string,
	limit = recentDeliveryCount,
	transport = httpTransport
): Promise<WebhookDeliveryRow[]> {
	const { results } = await db
		.prepare(
			`SELECT d.id, d.event_id, e.type, d.state, d.attempts, d.response_status, d.error_code, d.duration_ms,
				d.created_at, d.last_attempt_at, d.completed_at
			FROM webhook_deliveries d JOIN webhook_events e ON e.id = d.event_id
			JOIN webhook_endpoints w ON w.id = d.endpoint_id AND w.tenant_id = d.tenant_id AND w.transport = ?4
			WHERE d.tenant_id = ?1 AND d.endpoint_id = ?2 ORDER BY d.created_at DESC, d.id DESC LIMIT ?3`
		)
		.bind(tenantId, endpointId, batchSize(limit, 100), transportName(transport))
		.all<Record<string, unknown>>();
	return results.map((row) => ({
		id: text(row.id, 'delivery'),
		eventId: text(row.event_id, 'event'),
		eventType: eventType(row.type),
		state: deliveryState(row.state),
		attempts: count(row.attempts, 'attempts'),
		responseStatus: optionalCount(row.response_status, 'response status'),
		errorCode: deliveryError(row.error_code),
		durationMs: optionalCount(row.duration_ms, 'duration'),
		createdAt: count(row.created_at, 'delivery time'),
		lastAttemptAt: optionalCount(row.last_attempt_at, 'attempt time'),
		completedAt: optionalCount(row.completed_at, 'completion time')
	}));
}
