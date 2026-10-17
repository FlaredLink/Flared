// SPDX-License-Identifier: AGPL-3.0-only
// Browser calls to the webhook routes of the /v1 API over the dashboard session. The page passes
// its API base path, and the browser sends the session cookie and its Origin with each change.
// Each response is checked at run time: a body of the wrong shape counts as a failed request.
import {
	isWebhookEndpoint,
	isWebhookEndpointPage,
	isWebhookEventType,
	webhookDeliveryErrors,
	type CreateWebhookInput,
	type CreatedWebhookEndpoint,
	type UpdateWebhookInput,
	type WebhookDelivery,
	type WebhookDeliveryError,
	type WebhookEndpoint,
	type WebhookEndpointPage
} from '@flared/contracts/webhooks';

export interface WebhookFailure {
	code: string;
	// The API's own message, used when it names the exact problem with the input.
	message: string | null;
	field: string | null;
	retryAfterSeconds: number | null;
}

export type WebhookResult<T> = { ok: true; value: T } | { ok: false; failure: WebhookFailure };

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isString = (value: unknown): value is string => typeof value === 'string';
const isOptionalString = (value: unknown): value is string | null =>
	value === null || typeof value === 'string';
const isCount = (value: unknown): value is number =>
	typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isOptionalCount = (value: unknown): value is number | null =>
	value === null || isCount(value);
const deliveryStates: readonly string[] = ['pending', 'succeeded', 'failed', 'skipped'];

function isDeliveryError(value: unknown): value is WebhookDeliveryError {
	return isString(value) && (webhookDeliveryErrors as readonly string[]).includes(value);
}

export function isWebhookDelivery(value: unknown): value is WebhookDelivery {
	return (
		record(value) &&
		isString(value.id) &&
		isString(value.eventId) &&
		isWebhookEventType(value.eventType) &&
		isString(value.state) &&
		deliveryStates.includes(value.state) &&
		isCount(value.attempts) &&
		isOptionalCount(value.responseStatus) &&
		(value.errorCode === null || isDeliveryError(value.errorCode)) &&
		isOptionalCount(value.durationMs) &&
		isString(value.createdAt) &&
		isOptionalString(value.lastAttemptAt) &&
		isOptionalString(value.completedAt)
	);
}

// The create and rotate responses carry the secret once, next to the endpoint.
export function isCreatedWebhookEndpoint(value: unknown): value is CreatedWebhookEndpoint {
	return (
		record(value) && isWebhookEndpoint(value.endpoint) && isString(value.secret) && !!value.secret
	);
}

export async function webhookFailureOf(response: Response): Promise<WebhookFailure> {
	const body: unknown = await response.json().catch(() => null);
	const error = record(body) && record(body.error) ? body.error : {};
	const retryAfter = Number(response.headers.get('retry-after'));
	// Any 429 is a wait, also one from a proxy without a Flared error body.
	const code =
		response.status === 429
			? 'RATE_LIMITED'
			: typeof error.code === 'string'
				? error.code
				: 'SERVICE_UNAVAILABLE';
	return {
		code,
		message: typeof error.message === 'string' ? error.message : null,
		field: typeof error.field === 'string' ? error.field : null,
		retryAfterSeconds: Number.isSafeInteger(retryAfter) && retryAfter > 0 ? retryAfter : null
	};
}

const failure = (code: string): WebhookFailure => ({
	code,
	message: null,
	field: null,
	retryAfterSeconds: null
});

// One request. expected is the success status; read turns its body into the value, or null when
// the body has the wrong shape.
async function call<T>(
	url: string,
	init: RequestInit,
	expected: number,
	read: (body: unknown) => T | null
): Promise<WebhookResult<T>> {
	let response: Response;
	try {
		response = await fetch(url, init);
	} catch {
		return { ok: false, failure: failure('NETWORK_ERROR') };
	}
	if (response.status !== expected) return { ok: false, failure: await webhookFailureOf(response) };
	const body: unknown = expected === 204 ? null : await response.json().catch(() => undefined);
	const value = read(body);
	return value === null
		? { ok: false, failure: failure('SERVICE_UNAVAILABLE') }
		: { ok: true, value };
}

const endpointPath = (apiBase: string, id: string) =>
	`${apiBase}/webhooks/${encodeURIComponent(id)}`;

const json = (method: string, body: unknown, workspace: Record<string, string>): RequestInit => ({
	method,
	headers: { 'content-type': 'application/json', ...workspace },
	body: JSON.stringify(body)
});

export function listWebhooks(
	apiBase: string,
	workspace: Record<string, string> = {}
): Promise<WebhookResult<WebhookEndpointPage>> {
	return call(`${apiBase}/webhooks`, { headers: workspace }, 200, (body) =>
		isWebhookEndpointPage(body) ? body : null
	);
}

export function createWebhook(
	apiBase: string,
	input: CreateWebhookInput,
	workspace: Record<string, string> = {}
): Promise<WebhookResult<CreatedWebhookEndpoint>> {
	return call(`${apiBase}/webhooks`, json('POST', input, workspace), 201, (body) =>
		isCreatedWebhookEndpoint(body) ? body : null
	);
}

export function updateWebhook(
	apiBase: string,
	id: string,
	input: UpdateWebhookInput,
	workspace: Record<string, string> = {}
): Promise<WebhookResult<WebhookEndpoint>> {
	return call(endpointPath(apiBase, id), json('PATCH', input, workspace), 200, (body) =>
		record(body) && isWebhookEndpoint(body.endpoint) ? body.endpoint : null
	);
}

export function deleteWebhook(
	apiBase: string,
	id: string,
	workspace: Record<string, string> = {}
): Promise<WebhookResult<true>> {
	return call(endpointPath(apiBase, id), { method: 'DELETE', headers: workspace }, 204, () => true);
}

export function rotateWebhookSecret(
	apiBase: string,
	id: string,
	workspace: Record<string, string> = {}
): Promise<WebhookResult<CreatedWebhookEndpoint>> {
	return call(
		`${endpointPath(apiBase, id)}/secret`,
		{ method: 'POST', headers: workspace },
		200,
		(body) => (isCreatedWebhookEndpoint(body) ? body : null)
	);
}

export function sendWebhookTest(
	apiBase: string,
	id: string,
	workspace: Record<string, string> = {}
): Promise<WebhookResult<WebhookDelivery>> {
	return call(
		`${endpointPath(apiBase, id)}/test`,
		{ method: 'POST', headers: workspace },
		200,
		(body) => (record(body) && isWebhookDelivery(body.delivery) ? body.delivery : null)
	);
}

export function listWebhookDeliveries(
	apiBase: string,
	id: string,
	workspace: Record<string, string> = {}
): Promise<WebhookResult<WebhookDelivery[]>> {
	return call(`${endpointPath(apiBase, id)}/deliveries`, { headers: workspace }, 200, (body) =>
		record(body) && Array.isArray(body.deliveries) && body.deliveries.every(isWebhookDelivery)
			? body.deliveries
			: null
	);
}

// The fields of an edit that differ from the endpoint, for a PATCH that sends only those. The
// server clears the interval when the events drop link.click_milestone, so none is sent then.
export function webhookChanges(
	endpoint: WebhookEndpoint,
	input: CreateWebhookInput
): UpdateWebhookInput {
	const changes: UpdateWebhookInput = {};
	if (input.url !== endpoint.url) changes.url = input.url;
	const sameEvents =
		input.events.length === endpoint.events.length &&
		input.events.every((event) => endpoint.events.includes(event));
	if (!sameEvents) changes.events = input.events;
	if (input.milestoneInterval !== null && input.milestoneInterval !== endpoint.milestoneInterval)
		changes.milestoneInterval = input.milestoneInterval;
	return changes;
}

// The host and path of an endpoint URL. The query and fragment stay out of the list, because a
// receiver can put a token there.
export function endpointLabel(url: string): string {
	try {
		const parsed = new URL(url);
		return parsed.pathname === '/' ? parsed.host : `${parsed.host}${parsed.pathname}`;
	} catch {
		return url;
	}
}

// Why a delivery failed or was skipped, in plain words.
export function deliveryReason(code: WebhookDeliveryError, responseStatus: number | null): string {
	switch (code) {
		case 'timeout':
			return 'No answer within 10 seconds.';
		case 'network':
			return 'Flared could not connect to the endpoint.';
		case 'redirect':
			return 'The endpoint answered with a redirect. Flared does not follow redirects.';
		case 'http_status':
			return responseStatus === null
				? 'The endpoint answered with an error.'
				: `The endpoint answered HTTP ${responseStatus}.`;
		case 'invalid_url':
			return 'Flared no longer accepts this URL. Change it or delete the endpoint.';
		case 'secret_changed':
			return 'Rotate the secret to continue.';
		case 'plan':
			return 'Webhooks are off for this workspace.';
		case 'disabled':
			return 'The endpoint is off.';
		case 'expired':
			return 'Not delivered within 72 hours.';
		case 'transport_missing':
			return 'This installation cannot send to this endpoint.';
		case 'unauthorized':
			return 'The connection was refused. Connect again to continue.';
		case 'target_unavailable':
			return 'The place to post is no longer available.';
		case 'rate_limited':
			return 'Too many messages for now. Flared tries again later.';
		case 'rejected':
			return 'The message was refused.';
	}
}

// What went wrong with a request, in plain words.
export function webhookErrorMessage(failure: WebhookFailure): string {
	switch (failure.code) {
		case 'REAUTH_REQUIRED':
			return 'Confirm it’s you, then try again.';
		case 'WEBHOOK_LIMIT_REACHED':
			return 'You have reached the endpoint limit. Delete an endpoint before you add another.';
		// The API names the exact problem with the field.
		case 'INVALID_INPUT':
			return failure.message ?? 'Check the URL and choose at least one event.';
		case 'OWNER_REQUIRED':
			return 'Only the workspace owner can manage webhooks.';
		case 'RATE_LIMITED': {
			const minutes = Math.ceil((failure.retryAfterSeconds ?? 3600) / 60);
			return `Too many test events for now. Try again in ${minutes === 1 ? '1 minute' : `${minutes} minutes`}.`;
		}
		case 'NOT_FOUND':
			return 'This endpoint no longer exists. Reload the page.';
		case 'WORKSPACE_CHANGED':
			return 'You switched workspaces in another tab. Reload the page to continue.';
		case 'WORKSPACE_SUSPENDED':
			return 'Flared suspended this workspace. You can still delete endpoints.';
		case 'UNAUTHENTICATED':
			return 'Your session ended. Sign in again.';
		case 'NETWORK_ERROR':
			return 'We could not reach Flared. Check your connection and try again.';
		default:
			return 'Something went wrong. Try again.';
	}
}
