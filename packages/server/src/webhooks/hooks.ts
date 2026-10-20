// SPDX-License-Identifier: AGPL-3.0-only
// The sender of REST hooks: a client such as Zapier subscribes a target URL through the API, and
// each event goes to it as one flat JSON object, so the client maps the link fields without
// nesting. The target URL is the secret, so a delivery carries no signature. A 410 answer means
// the subscription is gone: the hook turns off, and cleanup deletes it.
import { parseHookUrl } from '@flared/contracts/webhooks';
import {
	drain,
	webhookTimeoutMs,
	type ClaimedDelivery,
	type DeliveryResult,
	type WebhookTransport
} from './deliver';

export interface HookSenderOptions {
	// The hostnames that hooks may be sent to, as the subscribe route allows them.
	allowedHosts: readonly string[];
	fetch?: typeof fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// The link fields first, then what else the event carries (previous, clicks), then the event.
export function hookBody(delivery: ClaimedDelivery): string {
	const data: unknown = JSON.parse(delivery.event.payload);
	if (!isRecord(data)) throw new Error('Invalid stored webhook payload');
	const { link, ...rest } = data;
	return JSON.stringify({
		...(isRecord(link) ? link : {}),
		...rest,
		event: delivery.event.type,
		eventId: delivery.event.id,
		occurredAt: new Date(delivery.event.createdAt).toISOString()
	});
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

async function sendOne(
	delivery: ClaimedDelivery,
	options: HookSenderOptions,
	fetcher: typeof fetch
): Promise<DeliveryResult> {
	let url: string;
	try {
		url = parseHookUrl(delivery.endpoint.url, options.allowedHosts);
	} catch {
		return result(delivery, 'failed', { errorCode: 'invalid_url' });
	}
	let body: string;
	try {
		body = hookBody(delivery);
	} catch {
		// The payload can never become valid; a retry would only wait for the 72-hour expiry.
		return result(delivery, 'failed', { errorCode: 'rejected' });
	}
	const started = Date.now();
	let response: Response;
	try {
		response = await fetcher(url, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'user-agent': 'Flared-Hooks/1.0',
				'webhook-id': delivery.event.id
			},
			body,
			// A redirect is a failure: following it could reach a host the list does not allow.
			redirect: 'manual',
			signal: AbortSignal.timeout(webhookTimeoutMs)
		});
	} catch (error) {
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
	if (responseStatus === 410)
		return result(delivery, 'failed', {
			responseStatus,
			errorCode: 'target_unavailable',
			durationMs
		});
	const redirected = responseStatus >= 300 && responseStatus < 400;
	return result(delivery, 'retry', {
		responseStatus,
		errorCode: redirected ? 'redirect' : 'http_status',
		durationMs
	});
}

// Register it under hookTransport ('resthook') in the edition's webhook transports.
export function hookSender(options: HookSenderOptions): WebhookTransport {
	// Called as fetcher(...): the Workers global fetch throws "Illegal invocation" when it runs
	// with another `this`, so the default goes through a plain call.
	const fetcher: typeof fetch = options.fetch ?? ((input, init) => fetch(input, init));
	return {
		async send(deliveries, context) {
			const results: DeliveryResult[] = [];
			let next = 0;
			const worker = async () => {
				while (next < deliveries.length) {
					const delivery = deliveries[next];
					next += 1;
					results.push(await sendOne(delivery, options, fetcher));
				}
			};
			await Promise.all(
				Array.from({ length: Math.min(context.concurrency, deliveries.length) }, () => worker())
			);
			return results;
		}
	};
}
