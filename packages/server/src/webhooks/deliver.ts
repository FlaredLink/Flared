// SPDX-License-Identifier: AGPL-3.0-only
// Webhook delivery: fan events out, claim deliveries, send them, and record the results. A
// request that stages an event delivers its own workspace's new deliveries in the background;
// the scheduled job can move click milestones from the analytics shards, then fans out what is
// left, sends retries, and cleans up. Delivery is at least once: a receiver dedupes on webhook-id.
// An endpoint of the http transport gets the signed POST; an endpoint of another transport goes
// to the edition's sender for that transport.
import type { D1Database } from '@cloudflare/workers-types/index.ts';
import {
	parseWebhookUrl,
	webhookDeliveryErrors,
	type WebhookEnvelope
} from '@flared/contracts/webhooks';
import {
	claimWebhookDeliveries,
	deleteEndedHooks,
	deleteOldWebhookRecords,
	expireWebhookDeliveries,
	fanOutWebhookEvents,
	finishWebhookDeliveries,
	readClaimedDeliveries,
	type ClaimedDelivery,
	type DeliveryResult
} from '@flared/data/webhooks';
import { transferClickMilestones } from '../automations/milestones';
import type { AnalyticsShards } from '../shards';
import { endpointSecret, keyId, signatureHeader } from './signing';

// A receiver has this long to answer.
export const webhookTimeoutMs = 10_000;
// Only this much of a response is read; the rest is cancelled.
const responseBytes = 1024;
const defaultConcurrency = 5;
const httpTransport = 'http';
// Events fanned out in one run.
const fanOutBatch = 100;
// Rows expired or deleted in each statement of a cleanup run.
const cleanupBatch = 1000;
// claimWebhookDeliveries takes at most this many at once.
const claimBatch = 100;

export type { ClaimedDelivery, DeliveryResult } from '@flared/data/webhooks';

// The edition's sender for the endpoints of one transport other than http. A round calls send
// once with that transport's claimed deliveries, at most concurrency requests at once. It returns
// one result per delivery, with the delivery's id; a delivery without a result retries as a
// network failure. A failed unauthorized turns off every endpoint of the workspace on this
// transport; a failed target_unavailable turns off the endpoint; rate_limited retries without
// a pause, and the receiver errors (timeout, network, redirect, http_status) pause the endpoint.
export interface WebhookTransport {
	send(
		deliveries: readonly ClaimedDelivery[],
		context: { now: number; concurrency: number }
	): Promise<DeliveryResult[]>;
}

export interface WebhookSendSettings {
	// The deployment secret that endpoint secrets are derived from.
	secret: string;
	// The installation's own hostnames. A URL on one of them fails at send time, as at creation.
	reservedHostnames: readonly string[];
	fetch?: typeof fetch;
	// Requests at once. 5 by default.
	concurrency?: number;
	now?: () => number;
	// The edition's senders by transport name. A delivery to an endpoint of a transport with no
	// sender fails as transport_missing.
	transports?: Readonly<Record<string, WebhookTransport>>;
}

export interface WebhookRunSummary {
	sent: number;
	succeeded: number;
	failed: number;
}

// The body of a delivery. The stored payload is the event's data object.
export function webhookBody(delivery: ClaimedDelivery): string {
	const data: unknown = JSON.parse(delivery.event.payload);
	if (typeof data !== 'object' || data === null || Array.isArray(data))
		throw new Error('Invalid stored webhook payload');
	const envelope: WebhookEnvelope<unknown> = {
		id: delivery.event.id,
		type: delivery.event.type,
		timestamp: new Date(delivery.event.createdAt).toISOString(),
		workspace: { id: delivery.tenantId },
		data
	};
	return JSON.stringify(envelope);
}

// Reads at most responseBytes of the body, then lets the rest go. Destination checks use it too.
export async function drain(response: Response): Promise<void> {
	if (!response.body) return;
	const reader = response.body.getReader();
	let size = 0;
	try {
		while (size < responseBytes) {
			const { done, value } = await reader.read();
			if (done) return;
			size += value.byteLength;
		}
		await reader.cancel();
	} catch {
		// The status is all a delivery records; a broken body changes nothing.
	}
}

function result(
	delivery: ClaimedDelivery,
	outcome: DeliveryResult['outcome'],
	fields: Partial<Pick<DeliveryResult, 'responseStatus' | 'errorCode' | 'durationMs'>> = {}
): DeliveryResult {
	return {
		id: delivery.id,
		endpointId: delivery.endpoint.id,
		outcome,
		responseStatus: fields.responseStatus ?? null,
		errorCode: fields.errorCode ?? null,
		durationMs: fields.durationMs ?? null
	};
}

interface SendContext {
	settings: WebhookSendSettings;
	currentKeyId: string;
	fetcher: typeof fetch;
	now: () => number;
}

async function send(delivery: ClaimedDelivery, context: SendContext): Promise<DeliveryResult> {
	const { endpoint, event } = delivery;
	// The edition's message has no meaning to a receiver; fan-out never sends one to http.
	if (event.type === 'integration.message')
		return result(delivery, 'skipped', { errorCode: 'disabled' });
	// The secret came from another deployment secret and cannot be derived now.
	if (endpoint.keyId !== context.currentKeyId)
		return result(delivery, 'failed', { errorCode: 'secret_changed' });
	// Turned off after the fan-out. A test event goes to its endpoint either way; an automation
	// event, though targeted, does not.
	if (!endpoint.enabled && event.type !== 'webhook.test')
		return result(delivery, 'skipped', { errorCode: 'disabled' });
	let url: string;
	try {
		url = parseWebhookUrl(endpoint.url, context.settings.reservedHostnames);
	} catch {
		return result(delivery, 'failed', { errorCode: 'invalid_url' });
	}
	const body = webhookBody(delivery);
	const time = context.now();
	const secrets = [
		...(endpoint.previousSecretUntil !== null &&
		endpoint.previousSecretUntil > time &&
		endpoint.secretVersion > 1
			? [await endpointSecret(context.settings.secret, endpoint.id, endpoint.secretVersion - 1)]
			: []),
		await endpointSecret(context.settings.secret, endpoint.id, endpoint.secretVersion)
	];
	const timestamp = Math.floor(time / 1000);
	const started = Date.now();
	let response: Response;
	try {
		response = await context.fetcher(url, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'user-agent': 'Flared-Webhooks/1.0',
				'webhook-id': event.id,
				'webhook-timestamp': String(timestamp),
				'webhook-signature': await signatureHeader(secrets, event.id, timestamp, body)
			},
			body,
			// A redirect is a failure: following it could reach an address the URL check refused.
			redirect: 'manual',
			signal: AbortSignal.timeout(webhookTimeoutMs)
		});
	} catch (error) {
		// AbortSignal.timeout rejects with a DOMException named TimeoutError.
		const timedOut =
			typeof error === 'object' && error !== null && Reflect.get(error, 'name') === 'TimeoutError';
		return result(delivery, 'retry', {
			errorCode: timedOut ? 'timeout' : 'network',
			durationMs: Date.now() - started
		});
	}
	await drain(response);
	const durationMs = Date.now() - started;
	const responseStatus = response.status;
	if (responseStatus >= 200 && responseStatus < 300)
		return result(delivery, 'succeeded', { responseStatus, durationMs });
	const redirected = responseStatus >= 300 && responseStatus < 400;
	return result(delivery, 'retry', {
		responseStatus,
		errorCode: redirected ? 'redirect' : 'http_status',
		durationMs
	});
}

// Logs carry IDs and codes only: never a URL, a destination, a payload, or a secret.
function logResult(delivery: ClaimedDelivery, outcome: DeliveryResult): void {
	const line = JSON.stringify({
		event: `webhook_${outcome.outcome}`,
		deliveryId: delivery.id,
		endpointId: delivery.endpoint.id,
		status: outcome.responseStatus,
		errorCode: outcome.errorCode,
		attempt: delivery.attempts
	});
	if (outcome.outcome === 'succeeded') console.log(line);
	else console.error(line);
}

const outcomes: readonly DeliveryResult['outcome'][] = ['succeeded', 'retry', 'failed', 'skipped'];

function nullableCount(value: unknown): value is number | null {
	return value === null || (Number.isSafeInteger(value) && Number(value) >= 0);
}

// A sender's result for one of its deliveries, checked at run time: the endpoint comes from the
// claimed delivery, so a sender cannot turn off another endpoint. Anything else is left out.
function checkedResult(delivery: ClaimedDelivery, value: unknown): DeliveryResult | null {
	if (typeof value !== 'object' || value === null) return null;
	const outcome = outcomes.find((item) => item === Reflect.get(value, 'outcome'));
	const errorCode: unknown = Reflect.get(value, 'errorCode');
	const responseStatus: unknown = Reflect.get(value, 'responseStatus');
	const durationMs: unknown = Reflect.get(value, 'durationMs');
	const code = webhookDeliveryErrors.find((item) => item === errorCode);
	if (
		outcome === undefined ||
		(errorCode !== null && code === undefined) ||
		!nullableCount(responseStatus) ||
		!nullableCount(durationMs)
	)
		return null;
	return result(delivery, outcome, { errorCode: code ?? null, responseStatus, durationMs });
}

// One call to the transport's sender with every delivery of the round that it can send. A
// delivery turned off after the fan-out is skipped here, as for http, unless it is a test.
async function sendThrough(
	transport: string,
	deliveries: ClaimedDelivery[],
	context: SendContext,
	concurrency: number
): Promise<DeliveryResult[]> {
	const sender = context.settings.transports?.[transport];
	if (!sender)
		return deliveries.map((delivery) =>
			result(delivery, 'failed', { errorCode: 'transport_missing' })
		);
	const results = new Map<string, DeliveryResult>();
	const sendable: ClaimedDelivery[] = [];
	for (const delivery of deliveries)
		if (!delivery.endpoint.enabled && delivery.event.type !== 'webhook.test')
			results.set(delivery.id, result(delivery, 'skipped', { errorCode: 'disabled' }));
		else sendable.push(delivery);
	if (sendable.length > 0) {
		let returned: readonly unknown[] = [];
		try {
			const value: unknown = await sender.send(sendable, { now: context.now(), concurrency });
			if (Array.isArray(value)) returned = value;
		} catch {
			// Every delivery of the call retries below; the next run sends them again.
			console.error(JSON.stringify({ event: 'webhook_transport_failed', transport }));
		}
		const byId = new Map(sendable.map((delivery) => [delivery.id, delivery]));
		for (const value of returned) {
			const id: unknown =
				typeof value === 'object' && value !== null ? Reflect.get(value, 'id') : null;
			const delivery = typeof id === 'string' ? byId.get(id) : undefined;
			if (!delivery || results.has(delivery.id)) continue;
			const checked = checkedResult(delivery, value);
			if (checked) results.set(delivery.id, checked);
		}
	}
	return deliveries.map(
		(delivery) => results.get(delivery.id) ?? result(delivery, 'retry', { errorCode: 'network' })
	);
}

// Sends a round: the http deliveries as signed POSTs, at most concurrency at once, and each other
// transport's deliveries in one call to its sender, all at the same time. Results keep the order
// of the deliveries.
async function sendAll(
	deliveries: ClaimedDelivery[],
	settings: WebhookSendSettings
): Promise<DeliveryResult[]> {
	const concurrency = settings.concurrency ?? defaultConcurrency;
	if (!Number.isSafeInteger(concurrency) || concurrency < 1)
		throw new Error('Invalid webhook concurrency');
	if (deliveries.length === 0) return [];
	const context: SendContext = {
		settings,
		currentKeyId: await keyId(settings.secret),
		// Called as context.fetcher(...): the Workers global fetch throws "Illegal invocation" when it
		// runs with another `this`, so the default goes through a plain call.
		fetcher: settings.fetch ?? ((input, init) => fetch(input, init)),
		now: settings.now ?? Date.now
	};
	const byTransport = new Map<string, ClaimedDelivery[]>();
	for (const delivery of deliveries) {
		const group = byTransport.get(delivery.endpoint.transport) ?? [];
		group.push(delivery);
		byTransport.set(delivery.endpoint.transport, group);
	}
	const http = byTransport.get(httpTransport) ?? [];
	byTransport.delete(httpTransport);
	const results = new Map<string, DeliveryResult>();
	let next = 0;
	const worker = async () => {
		while (next < http.length) {
			const delivery = http[next];
			next += 1;
			results.set(delivery.id, await send(delivery, context));
		}
	};
	await Promise.all([
		...Array.from({ length: Math.min(concurrency, http.length) }, () => worker()),
		...[...byTransport].map(async ([transport, group]) => {
			for (const outcome of await sendThrough(transport, group, context, concurrency))
				results.set(outcome.id, outcome);
		})
	]);
	return deliveries.map((delivery) => {
		const outcome = results.get(delivery.id);
		if (!outcome) throw new Error('A webhook delivery has no result');
		logResult(delivery, outcome);
		return outcome;
	});
}

function summarize(results: DeliveryResult[]): WebhookRunSummary {
	return {
		sent: results.length,
		succeeded: results.filter((item) => item.outcome === 'succeeded').length,
		failed: results.filter((item) => item.outcome !== 'succeeded').length
	};
}

// Claims at most limit deliveries, sends them, and records the results: a claim, a read, and a
// 2-statement batch (3 when a result turns an endpoint off); only the claim when nothing is due.
async function claimAndSend(
	routing: D1Database,
	claim: Parameters<typeof claimWebhookDeliveries>[1],
	settings: WebhookSendSettings
): Promise<DeliveryResult[]> {
	const ids = await claimWebhookDeliveries(routing, claim);
	const deliveries = await readClaimedDeliveries(routing, ids);
	const results = await sendAll(deliveries, settings);
	await finishWebhookDeliveries(routing, results, (settings.now ?? Date.now)());
	return results;
}

// The request path, after a change that staged an event: the workspace's own events are fanned
// out and its never-tried deliveries sent, at most limit (5 by default). 7 D1 statements: a
// 3-statement fan-out batch, the claim, the read, and the 2-statement result batch.
export async function deliverWebhooks(
	routing: D1Database,
	tenantId: string,
	settings: WebhookSendSettings & { limit?: number }
): Promise<WebhookRunSummary> {
	const now = (settings.now ?? Date.now)();
	await fanOutWebhookEvents(routing, { now, limit: fanOutBatch, tenantId });
	const results = await claimAndSend(
		routing,
		{ now, limit: settings.limit ?? defaultConcurrency, tenantId, untriedOnly: true },
		settings
	);
	return summarize(results);
}

// A test send: the workspace's events are fanned out, then only this event's delivery is sent,
// even to a paused endpoint. The result is stored with the delivery.
export async function deliverWebhookEvent(
	routing: D1Database,
	tenantId: string,
	eventId: string,
	settings: WebhookSendSettings
): Promise<WebhookRunSummary> {
	const now = (settings.now ?? Date.now)();
	await fanOutWebhookEvents(routing, { now, limit: fanOutBatch, tenantId });
	return summarize(await claimAndSend(routing, { now, limit: 1, tenantId, eventId }, settings));
}

export interface WebhookJobSummary extends WebhookRunSummary {
	milestones: number;
	events: number;
}

// The scheduled run. With transferMilestones (the default), each shard's waiting milestones first
// become events and mark the clicks automations they reach (transferClickMilestones: a read, and
// 3 more statements when milestones wait). Leftovers are fanned out (3), and due deliveries are
// claimed and sent up to maxDeliveries (25 by default) in rounds of at most 100 (4 statements
// each). An edition whose automation job moves the milestones passes false. A shard that fails
// does not stop the deliveries; the run then throws, so the job records a failure.
export async function runWebhookJob(
	stores: { routing: D1Database; analytics: AnalyticsShards },
	settings: WebhookSendSettings & { maxDeliveries?: number; transferMilestones?: boolean }
): Promise<WebhookJobSummary> {
	const { routing } = stores;
	const now = (settings.now ?? Date.now)();
	const { milestones, failedShards } =
		(settings.transferMilestones ?? true)
			? await transferClickMilestones(stores, now)
			: { milestones: 0, failedShards: [] };
	const fanned = await fanOutWebhookEvents(routing, { now, limit: fanOutBatch });
	const maxDeliveries = settings.maxDeliveries ?? 25;
	if (!Number.isSafeInteger(maxDeliveries) || maxDeliveries < 0)
		throw new Error('Invalid webhook delivery limit');
	const results: DeliveryResult[] = [];
	while (results.length < maxDeliveries) {
		const limit = Math.min(claimBatch, maxDeliveries - results.length);
		const round = await claimAndSend(routing, { now, limit }, settings);
		results.push(...round);
		if (round.length < limit) break;
	}
	// The shard's milestones wait for the next run.
	if (failedShards.length > 0)
		throw new Error('Click milestones could not be moved from every analytics shard');
	return { ...summarize(results), milestones, events: fanned.events };
}

// The daily run: deliveries pending past 72 hours fail as expired, deliveries and events past 30
// days are deleted, and so are hooks that have ended. 5 statements.
export async function cleanupWebhooks(
	routing: D1Database,
	now: number
): Promise<{ expired: number; deleted: number; hooks: number }> {
	const expired = await expireWebhookDeliveries(routing, now, cleanupBatch);
	const deleted = await deleteOldWebhookRecords(routing, now, cleanupBatch);
	const hooks = await deleteEndedHooks(routing, now, cleanupBatch);
	return { expired, deleted, hooks };
}
