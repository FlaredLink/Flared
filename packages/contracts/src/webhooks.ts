// SPDX-License-Identifier: AGPL-3.0-only
// Webhooks: event types, the endpoint and delivery shapes the dashboard shows, the create and
// update inputs, and the rules for an endpoint URL.
import type { AutomationActionType } from './automations';
import { isWithinHostnames } from './domains';
import { publicHostname } from './icons';
import { LinkInputError, type Link } from './links';

// Events an endpoint may subscribe to. The state change wins the type: an edit that also turns
// the link off is link.disabled.
export const subscribableWebhookEvents = [
	'link.created',
	'link.updated',
	'link.disabled',
	'link.enabled',
	'link.click_milestone'
] as const;
export type SubscribableWebhookEvent = (typeof subscribableWebhookEvents)[number];

// webhook.test and automation.triggered go only to the endpoint they target; no endpoint
// subscribes to them. An automation event skips a turned-off endpoint; a test reaches it.
export type WebhookEventType = SubscribableWebhookEvent | 'webhook.test' | 'automation.triggered';

export const maxWebhookUrlLength = 2048;
// Milestones are counted in steps of 100 clicks, so an interval is a multiple of 100.
export const milestoneStep = 100;
export const minMilestoneInterval = 100;
export const maxMilestoneInterval = 1_000_000;
// The interval an endpoint gets when it subscribes to milestones without choosing one.
export const defaultMilestoneInterval = 1000;

// Why a delivery failed or was skipped. timeout, network, redirect, and http_status come from
// the receiver; the rest from Flared.
export const webhookDeliveryErrors = [
	'timeout',
	'network',
	'redirect',
	'http_status',
	'invalid_url',
	'secret_changed',
	'plan',
	'disabled',
	'expired'
] as const;
export type WebhookDeliveryError = (typeof webhookDeliveryErrors)[number];

export type WebhookDeliveryState = 'pending' | 'succeeded' | 'failed' | 'skipped';

// What the dashboard shows. The signing secret is never stored, so no list can carry it.
export interface WebhookEndpoint {
	id: string;
	url: string;
	events: SubscribableWebhookEvent[];
	// Set while the endpoint subscribes to link.click_milestone.
	milestoneInterval: number | null;
	enabled: boolean;
	// Deliveries to the endpoint wait until this time after a failure.
	pausedUntil: string | null;
	failureCount: number;
	lastSuccessAt: string | null;
	lastFailureAt: string | null;
	// The previous secret still signs deliveries until this time after a rotation.
	previousSecretUntil: string | null;
	// The secret came from a deployment secret that has changed since, so no delivery can be
	// signed with it. A rotation ends it.
	secretChanged: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface WebhookEndpointPage {
	endpoints: WebhookEndpoint[];
	used: number;
	limit: number;
	eventTypes: SubscribableWebhookEvent[];
}

// The create and rotate responses are the only places the secret appears.
export interface CreatedWebhookEndpoint {
	endpoint: WebhookEndpoint;
	secret: string;
}

export interface WebhookDelivery {
	id: string;
	eventId: string;
	eventType: WebhookEventType;
	state: WebhookDeliveryState;
	attempts: number;
	responseStatus: number | null;
	errorCode: WebhookDeliveryError | null;
	durationMs: number | null;
	createdAt: string;
	lastAttemptAt: string | null;
	completedAt: string | null;
}

export interface WebhookDeliveryPage {
	deliveries: WebhookDelivery[];
}

// The body of each delivery. id is the webhook-id header; timestamp is when the event happened.
export interface WebhookEnvelope<Data = WebhookEventData> {
	id: string;
	type: WebhookEventType;
	timestamp: string;
	workspace: { id: string };
	data: Data;
}

// What changed in an edit, before the change.
export interface LinkPreviousState {
	destination: string;
	title: string | null;
	iosDestination: string | null;
	androidDestination: string | null;
	enabled: boolean;
}

// The trigger of an automation.triggered event, with what met it.
export type AutomationTriggerPayload =
	| { type: 'end_date'; endsAt: string | null }
	| { type: 'link_age'; days: number }
	| { type: 'clicks'; clicks: number }
	| { type: 'destination_down'; lastResult: string | null };

// link is the link after the run's changes; actions are the ones that ran, in their order.
export interface AutomationTriggeredData {
	automation: { id: string; name: string; trigger: AutomationTriggerPayload };
	link: Link;
	actions: AutomationActionType[];
}

export type WebhookEventData =
	| { link: Link }
	| { link: Link; previous: LinkPreviousState }
	| { link: Link; clicks: number }
	| { message: string }
	| AutomationTriggeredData;

export interface CreateWebhookInput {
	url: string;
	events: SubscribableWebhookEvent[];
	milestoneInterval: number | null;
}

// undefined keeps a field. The stored interval follows the events: without link.click_milestone
// it is cleared; with it, a missing interval keeps the stored one or takes the default.
export interface UpdateWebhookInput {
	url?: string;
	events?: SubscribableWebhookEvent[];
	milestoneInterval?: number;
	enabled?: boolean;
}

// An event ID for a link change or a test send. A click milestone has its own stable ID.
export function newWebhookEventId(): string {
	return `evt_${crypto.randomUUID().replaceAll('-', '')}`;
}

export function isSubscribableWebhookEvent(value: unknown): value is SubscribableWebhookEvent {
	return (
		typeof value === 'string' && (subscribableWebhookEvents as readonly string[]).includes(value)
	);
}

export function isWebhookEventType(value: unknown): value is WebhookEventType {
	return (
		value === 'webhook.test' ||
		value === 'automation.triggered' ||
		isSubscribableWebhookEvent(value)
	);
}

// An https URL on the default port, without a user name or password, on a public hostname that
// is not one of the installation's own hostnames or a subdomain of one.
export function parseWebhookUrl(
	value: unknown,
	reservedHostnames: readonly string[],
	field = 'url'
): string {
	if (typeof value !== 'string' || !value.trim())
		throw new LinkInputError(field, 'Enter the endpoint URL.');
	const input = value.trim();
	if (input.length > maxWebhookUrlLength)
		throw new LinkInputError(field, 'Use a URL of at most 2,048 characters.');
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		throw new LinkInputError(field, 'Enter a full URL that starts with https://.');
	}
	if (url.protocol !== 'https:') throw new LinkInputError(field, 'Use an https URL.');
	if (url.username || url.password)
		throw new LinkInputError(field, 'Remove the user name or password from the URL.');
	if (url.port) throw new LinkInputError(field, 'Use the default https port.');
	const hostname = publicHostname(url.hostname);
	if (!hostname) throw new LinkInputError(field, 'Use a hostname on a public domain.');
	if (isWithinHostnames(hostname, reservedHostnames))
		throw new LinkInputError(field, 'This hostname belongs to the installation.');
	if (url.href.length > maxWebhookUrlLength)
		throw new LinkInputError(field, 'Use a URL of at most 2,048 characters.');
	return url.href;
}

export function parseMilestoneInterval(value: unknown): number {
	if (
		typeof value !== 'number' ||
		!Number.isSafeInteger(value) ||
		value < minMilestoneInterval ||
		value > maxMilestoneInterval ||
		value % milestoneStep !== 0
	)
		throw new LinkInputError(
			'milestoneInterval',
			'Use a multiple of 100 clicks from 100 to 1,000,000.'
		);
	return value;
}

function parseEvents(value: unknown): SubscribableWebhookEvent[] {
	if (!Array.isArray(value) || value.length === 0 || !value.every(isSubscribableWebhookEvent))
		throw new LinkInputError('events', 'Choose at least one event.');
	return subscribableWebhookEvents.filter((event) => value.includes(event));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isOptionalText = (value: unknown) => value === null || typeof value === 'string';
const isCount = (value: unknown) =>
	typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export function isWebhookEndpoint(value: unknown): value is WebhookEndpoint {
	return (
		isRecord(value) &&
		typeof value.id === 'string' &&
		typeof value.url === 'string' &&
		Array.isArray(value.events) &&
		value.events.every(isSubscribableWebhookEvent) &&
		(value.milestoneInterval === null || isCount(value.milestoneInterval)) &&
		typeof value.enabled === 'boolean' &&
		isOptionalText(value.pausedUntil) &&
		isCount(value.failureCount) &&
		isOptionalText(value.lastSuccessAt) &&
		isOptionalText(value.lastFailureAt) &&
		isOptionalText(value.previousSecretUntil) &&
		typeof value.secretChanged === 'boolean' &&
		typeof value.createdAt === 'string' &&
		typeof value.updatedAt === 'string'
	);
}

export function isWebhookEndpointPage(value: unknown): value is WebhookEndpointPage {
	return (
		isRecord(value) &&
		Array.isArray(value.endpoints) &&
		value.endpoints.every(isWebhookEndpoint) &&
		isCount(value.used) &&
		isCount(value.limit) &&
		Array.isArray(value.eventTypes) &&
		value.eventTypes.every(isSubscribableWebhookEvent)
	);
}

function record(value: unknown): Record<string, unknown> {
	if (!isRecord(value)) throw new LinkInputError('body', 'Send a JSON object.');
	return value;
}

function onlyFields(body: Record<string, unknown>, allowed: string[]): void {
	for (const key of Object.keys(body))
		if (!allowed.includes(key)) throw new LinkInputError(key, `Unknown field "${key}".`);
}

// An endpoint that subscribes to milestones without an interval gets the default one; without
// milestones, it keeps none.
export function parseCreateWebhook(
	value: unknown,
	reservedHostnames: readonly string[]
): CreateWebhookInput {
	const body = record(value);
	onlyFields(body, ['url', 'events', 'milestoneInterval']);
	const events = parseEvents(body.events);
	const interval =
		body.milestoneInterval === undefined || body.milestoneInterval === null
			? defaultMilestoneInterval
			: parseMilestoneInterval(body.milestoneInterval);
	return {
		url: parseWebhookUrl(body.url, reservedHostnames),
		events,
		milestoneInterval: events.includes('link.click_milestone') ? interval : null
	};
}

export function parseUpdateWebhook(
	value: unknown,
	reservedHostnames: readonly string[]
): UpdateWebhookInput {
	const body = record(value);
	onlyFields(body, ['url', 'events', 'milestoneInterval', 'enabled']);
	const update: UpdateWebhookInput = {};
	if (body.url !== undefined) update.url = parseWebhookUrl(body.url, reservedHostnames);
	if (body.events !== undefined) update.events = parseEvents(body.events);
	if (body.milestoneInterval !== undefined && body.milestoneInterval !== null)
		update.milestoneInterval = parseMilestoneInterval(body.milestoneInterval);
	if (body.enabled !== undefined) {
		if (typeof body.enabled !== 'boolean')
			throw new LinkInputError('enabled', 'Use true or false.');
		update.enabled = body.enabled;
	}
	if (Object.keys(update).length === 0)
		throw new LinkInputError(
			'body',
			'Change the URL, the events, the milestone interval, or the enabled state.'
		);
	return update;
}
