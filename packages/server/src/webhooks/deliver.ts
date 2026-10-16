// SPDX-License-Identifier: AGPL-3.0-only
// Webhook delivery: fan events out, claim deliveries, send them, and record the results. A
// request that stages an event delivers its own workspace's new deliveries in the background;
// the scheduled job moves click milestones from the analytics shards, fans out what is left,
// sends retries, and cleans up. Delivery is at least once: a receiver dedupes on webhook-id.
import type { D1Database } from '@cloudflare/workers-types/index.ts';
import { parseWebhookUrl, type WebhookEnvelope } from '@flared/contracts/webhooks';
import {
	claimWebhookDeliveries,
	deleteClickMilestones,
	deleteOldWebhookRecords,
	expireWebhookDeliveries,
	fanOutWebhookEvents,
	finishWebhookDeliveries,
	insertMilestoneEvents,
	readClaimedDeliveries,
	readClickMilestones,
	type ClaimedDelivery,
	type DeliveryResult
} from '@flared/data/webhooks';
import type { AnalyticsShards } from '../shards';
import { endpointSecret, keyId, signatureHeader } from './signing';

// A receiver has this long to answer.
export const webhookTimeoutMs = 10_000;
// Only this much of a response is read; the rest is cancelled.
const responseBytes = 1024;
const defaultConcurrency = 5;
// Events fanned out in one run, and milestones moved from each shard.
const fanOutBatch = 100;
const milestoneBatch = 50;
// Rows expired or deleted in each statement of a cleanup run.
const cleanupBatch = 1000;
// claimWebhookDeliveries takes at most this many at once.
const claimBatch = 100;

export interface WebhookSendSettings {
	// The deployment secret that endpoint secrets are derived from.
	secret: string;
	// The installation's own hostnames. A URL on one of them fails at send time, as at creation.
	reservedHostnames: readonly string[];
	fetch?: typeof fetch;
	// Requests at once. 5 by default.
	concurrency?: number;
	now?: () => number;
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

// Reads at most responseBytes of the body, then lets the rest go.
async function drain(response: Response): Promise<void> {
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
	// The secret came from another deployment secret and cannot be derived now.
	if (endpoint.keyId !== context.currentKeyId)
		return result(delivery, 'failed', { errorCode: 'secret_changed' });
	// Turned off after the fan-out. A test event goes to its endpoint either way.
	if (!endpoint.enabled && !event.targeted)
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

async function sendAll(
	deliveries: ClaimedDelivery[],
	settings: WebhookSendSettings
): Promise<DeliveryResult[]> {
	const concurrency = settings.concurrency ?? defaultConcurrency;
	if (!Number.isSafeInteger(concurrency) || concurrency < 1)
		throw new Error('Invalid webhook concurrency');
	const context: SendContext = {
		settings,
		currentKeyId: await keyId(settings.secret),
		// Called as context.fetcher(...): the Workers global fetch throws "Illegal invocation" when it
		// runs with another `this`, so the default goes through a plain call.
		fetcher: settings.fetch ?? ((input, init) => fetch(input, init)),
		now: settings.now ?? Date.now
	};
	const results: DeliveryResult[] = new Array(deliveries.length);
	let next = 0;
	const worker = async () => {
		while (next < deliveries.length) {
			const index = next;
			next += 1;
			const outcome = await send(deliveries[index], context);
			logResult(deliveries[index], outcome);
			results[index] = outcome;
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(concurrency, deliveries.length) }, () => worker())
	);
	return results;
}

function summarize(results: DeliveryResult[]): WebhookRunSummary {
	return {
		sent: results.length,
		succeeded: results.filter((item) => item.outcome === 'succeeded').length,
		failed: results.filter((item) => item.outcome !== 'succeeded').length
	};
}

// Claims at most limit deliveries, sends them, and records the results: a claim, a read, and a
// 2-statement batch; only the claim when nothing is due.
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

// The scheduled run. Each shard's waiting milestones become events (at most 3 statements per
// shard: read, insert, delete; the insert comes first, so a stop in between writes nothing
// twice), leftovers are fanned out (3), and due deliveries are claimed and sent up to
// maxDeliveries (25 by default) in rounds of at most 100 (4 statements each). A shard that
// fails does not stop the deliveries; the run then throws, so the job records a failure.
export async function runWebhookJob(
	stores: { routing: D1Database; analytics: AnalyticsShards },
	settings: WebhookSendSettings & { maxDeliveries?: number }
): Promise<WebhookJobSummary> {
	const { routing } = stores;
	const now = (settings.now ?? Date.now)();
	let milestones = 0;
	const failedShards: string[] = [];
	for (const [shardId, shard] of Object.entries(stores.analytics))
		try {
			const waiting = await readClickMilestones(shard, milestoneBatch);
			if (waiting.length === 0) continue;
			milestones += await insertMilestoneEvents(routing, waiting);
			await deleteClickMilestones(
				shard,
				waiting.map((milestone) => milestone.id)
			);
		} catch {
			failedShards.push(shardId);
			console.error(JSON.stringify({ event: 'webhook_milestones_failed', shardId }));
		}
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

// The daily run: deliveries pending past 72 hours fail as expired, and deliveries and events
// past 30 days are deleted. 3 statements.
export async function cleanupWebhooks(
	routing: D1Database,
	now: number
): Promise<{ expired: number; deleted: number }> {
	const expired = await expireWebhookDeliveries(routing, now, cleanupBatch);
	const deleted = await deleteOldWebhookRecords(routing, now, cleanupBatch);
	return { expired, deleted };
}
