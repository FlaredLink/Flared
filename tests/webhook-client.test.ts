// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebhookDelivery, WebhookEndpoint } from '../packages/contracts/src/webhooks';
import {
	createWebhook,
	deleteWebhook,
	endpointLabel,
	isCreatedWebhookEndpoint,
	isWebhookDelivery,
	listWebhookDeliveries,
	sendWebhookTest,
	webhookChanges,
	webhookErrorMessage,
	webhookFailureOf
} from '../packages/ui/src/webhooks/client';

const endpoint: WebhookEndpoint = {
	id: 'whe_1',
	url: 'https://hooks.example.com/flared?token=abc',
	events: ['link.created', 'link.click_milestone'],
	milestoneInterval: 1000,
	enabled: true,
	pausedUntil: null,
	failureCount: 0,
	lastSuccessAt: '2026-10-17T09:00:00.000Z',
	lastFailureAt: null,
	previousSecretUntil: null,
	secretChanged: false,
	createdAt: '2026-10-17T08:00:00.000Z',
	updatedAt: '2026-10-17T08:00:00.000Z'
};

const delivery: WebhookDelivery = {
	id: 'whd_1',
	eventId: 'evt_1',
	eventType: 'webhook.test',
	state: 'failed',
	attempts: 1,
	responseStatus: null,
	errorCode: 'secret_changed',
	durationMs: null,
	createdAt: '2026-10-17T09:00:00.000Z',
	lastAttemptAt: '2026-10-17T09:00:00.000Z',
	completedAt: '2026-10-17T09:00:00.000Z'
};

function respond(status: number, body?: unknown, headers: Record<string, string> = {}) {
	vi.stubGlobal(
		'fetch',
		vi.fn(async () =>
			body === undefined
				? new Response(null, { status, headers })
				: Response.json(body, { status, headers })
		)
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('webhook response validation', () => {
	it('accepts the shapes in the contract', () => {
		expect(isWebhookDelivery(delivery)).toBe(true);
		expect(isCreatedWebhookEndpoint({ endpoint, secret: 'whsec_x' })).toBe(true);
	});

	it('refuses unknown events, states, and error codes', () => {
		expect(isWebhookDelivery({ ...delivery, state: 'sending' })).toBe(false);
		expect(isWebhookDelivery({ ...delivery, errorCode: 'teapot' })).toBe(false);
		expect(isWebhookDelivery({ ...delivery, eventType: 'link.deleted' })).toBe(false);
		expect(isCreatedWebhookEndpoint({ endpoint, secret: '' })).toBe(false);
		expect(
			isCreatedWebhookEndpoint({ endpoint: { ...endpoint, secretChanged: 'no' }, secret: 'x' })
		).toBe(false);
	});
});

describe('webhook failures', () => {
	it('reads the code, message, field, and wait from an error response', async () => {
		const failure = await webhookFailureOf(
			Response.json(
				{ error: { code: 'INVALID_INPUT', message: 'Use an https URL.', field: 'url' } },
				{ status: 400 }
			)
		);
		expect(failure).toEqual({
			code: 'INVALID_INPUT',
			message: 'Use an https URL.',
			field: 'url',
			retryAfterSeconds: null
		});
		expect(webhookErrorMessage(failure)).toBe('Use an https URL.');
	});

	it('treats any 429 as a wait, also without a Flared body', async () => {
		const failure = await webhookFailureOf(
			new Response('slow down', { status: 429, headers: { 'retry-after': '120' } })
		);
		expect(failure.code).toBe('RATE_LIMITED');
		expect(failure.retryAfterSeconds).toBe(120);
		expect(webhookErrorMessage(failure)).toBe(
			'Too many test events for now. Try again in 2 minutes.'
		);
	});

	it('maps a body without an error code to SERVICE_UNAVAILABLE', async () => {
		const failure = await webhookFailureOf(new Response('<html>', { status: 502 }));
		expect(failure.code).toBe('SERVICE_UNAVAILABLE');
	});
});

describe('webhook calls', () => {
	it('returns the endpoint and the secret from a create', async () => {
		respond(201, { endpoint, secret: 'whsec_x' });
		const result = await createWebhook('/api/v1', {
			url: endpoint.url,
			events: endpoint.events,
			milestoneInterval: 1000
		});
		expect(result).toEqual({ ok: true, value: { endpoint, secret: 'whsec_x' } });
	});

	it('passes REAUTH_REQUIRED through from a create', async () => {
		respond(403, { error: { code: 'REAUTH_REQUIRED', message: 'Sign in again.' } });
		const result = await createWebhook('/api/v1', {
			url: endpoint.url,
			events: ['link.created'],
			milestoneInterval: null
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.failure.code).toBe('REAUTH_REQUIRED');
	});

	it('counts a success status with the wrong body as a failure', async () => {
		respond(200, { delivery: { ...delivery, attempts: 'one' } });
		const result = await sendWebhookTest('/api/v1', 'whe_1');
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.failure.code).toBe('SERVICE_UNAVAILABLE');

		respond(200, { deliveries: [delivery, { id: 'x' }] });
		const list = await listWebhookDeliveries('/api/v1', 'whe_1');
		expect(list.ok).toBe(false);
	});

	it('accepts 204 from a delete and reports a network error', async () => {
		respond(204);
		expect(await deleteWebhook('/api/v1', 'whe_1')).toEqual({ ok: true, value: true });

		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new TypeError('Failed to fetch');
			})
		);
		const result = await deleteWebhook('/api/v1', 'whe_1');
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.failure.code).toBe('NETWORK_ERROR');
	});
});

describe('endpointLabel', () => {
	it('shows the host and path and leaves out the query', () => {
		expect(endpointLabel(endpoint.url)).toBe('hooks.example.com/flared');
		expect(endpointLabel('https://hooks.example.com/')).toBe('hooks.example.com');
	});
});

describe('webhookChanges', () => {
	const unchanged = {
		url: endpoint.url,
		events: [...endpoint.events].reverse(),
		milestoneInterval: 1000
	};

	it('sends nothing when the edit matches the endpoint', () => {
		expect(webhookChanges(endpoint, unchanged)).toEqual({});
	});

	it('sends only the changed fields', () => {
		expect(
			webhookChanges(endpoint, {
				...unchanged,
				url: 'https://hooks.example.com/new',
				milestoneInterval: 2500
			})
		).toEqual({ url: 'https://hooks.example.com/new', milestoneInterval: 2500 });
	});

	it('sends the events without an interval when milestones are dropped', () => {
		expect(
			webhookChanges(endpoint, { ...unchanged, events: ['link.created'], milestoneInterval: null })
		).toEqual({ events: ['link.created'] });
	});
});
