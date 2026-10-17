// SPDX-License-Identifier: AGPL-3.0-only
// Automations: a template is one trigger, then up to five actions that run in a fixed order. A
// template applied to a link runs once when its trigger is met; applying it again re-arms it.
import { isErrorCode, type ErrorCode } from './errors';
import { ImportRequestError, LinkInputError, parseDestination } from './links';

export const automationTriggerTypes = [
	'end_date',
	'link_age',
	'clicks',
	'destination_down'
] as const;
export type AutomationTriggerType = (typeof automationTriggerTypes)[number];

export type AutomationTrigger =
	| { type: 'end_date' }
	| { type: 'link_age'; days: number }
	| { type: 'clicks'; clicks: number }
	| { type: 'destination_down' };

// Also the order in which the actions run: the webhook and the message report the link after
// the change. post_message posts through an endpoint of another transport than http.
export const automationActionTypes = [
	'change_destination',
	'disable_link',
	'send_webhook',
	'post_message',
	'email_owner'
] as const;
export type AutomationActionType = (typeof automationActionTypes)[number];

export type AutomationAction =
	| { type: 'change_destination'; destination: string }
	| { type: 'disable_link' }
	| { type: 'send_webhook'; endpointId: string }
	| { type: 'post_message'; endpointId: string }
	| { type: 'email_owner' };

export const automationNameMaxLength = 80;
export const minTriggerDays = 1;
export const maxTriggerDays = 3650;
// Clicks are counted in steps of 100, as for webhook milestones.
export const triggerClickStep = 100;
export const minTriggerClicks = 100;
export const maxTriggerClicks = 100_000_000;
// Templates applied to one link at most.
export const automationsPerLink = 5;
// Links in one bulk apply request at most.
export const maxApplyLinks = 100;
// An end date is at most this far from now, before or after. A past date runs at the next run.
export const automationEndsAtRangeMs = 3653 * 86400000;
export const maxAutomationIdLength = 128;

// Why an application failed or was skipped. link_blocked, endpoint_missing, target_missing, and
// webhooks_off come from a run; plan, off, and attempts from the scheduler; not_checkable from a
// destination check. target_missing: the endpoint of post_message is gone.
export const automationResults = [
	'link_blocked',
	'endpoint_missing',
	'target_missing',
	'webhooks_off',
	'plan',
	'off',
	'attempts',
	'not_checkable'
] as const;
export type AutomationResult = (typeof automationResults)[number];

export interface Automation {
	id: string;
	name: string;
	enabled: boolean;
	trigger: AutomationTrigger;
	actions: AutomationAction[];
	// Links the template is applied to, whether it ran on them or not.
	links: number;
	createdAt: string;
	updatedAt: string;
}

export interface AutomationPage {
	automations: Automation[];
	used: number;
	limit: number;
	// What this installation offers: email_owner needs email, post_message needs messages,
	// destination_down needs checks.
	actionTypes: AutomationActionType[];
	triggerTypes: AutomationTriggerType[];
	perLinkLimit: typeof automationsPerLink;
}

export type LinkAutomationState = 'waiting' | 'done' | 'failed' | 'skipped';

export interface LinkAutomation {
	automationId: string;
	name: string;
	enabled: boolean;
	trigger: AutomationTrigger;
	state: LinkAutomationState;
	endsAt: string | null;
	// When the trigger is met, once that is known.
	dueAt: string | null;
	firedAt: string | null;
	result: AutomationResult | null;
	appliedAt: string;
	// Set for a destination_down template.
	check: { lastCheckedAt: string | null; lastResult: string | null; failures: number } | null;
}

export interface LinkAutomationPage {
	linkId: string;
	automations: LinkAutomation[];
}

// endsAt: ISO 8601 with an offset, only for an end_date template.
export interface ApplyAutomationInput {
	endsAt?: string;
}

export interface ApplyAutomationLinksInput {
	linkIds: string[];
	endsAt?: string;
}

// unchanged: the template already waits on the link with the same end date.
export type ApplyAutomationStatus = 'applied' | 'unchanged' | 'failed';

export interface ApplyAutomationLinkResult {
	linkId: string;
	status: ApplyAutomationStatus;
	error?: { code: ErrorCode; message: string };
}

export interface ApplyAutomationLinksResult {
	results: ApplyAutomationLinkResult[];
}

export type AutomationRunState = 'succeeded' | 'failed' | 'skipped';

export interface AutomationRun {
	id: string;
	linkId: string;
	shortUrl: string | null;
	state: AutomationRunState;
	result: AutomationResult | null;
	// The actions that ran, in their order.
	actions: AutomationActionType[];
	createdAt: string;
}

export interface AutomationRunPage {
	runs: AutomationRun[];
}

// The answer to PUT /v1/links/{id}/automations/{automationId}: the link's templates after the
// apply.
export interface ApplyLinkAutomationResult extends LinkAutomationPage {
	status: Exclude<ApplyAutomationStatus, 'failed'>;
}

export interface CreateAutomationInput {
	name: string;
	trigger: AutomationTrigger;
	actions: AutomationAction[];
}

// undefined keeps a field. The trigger type never changes; its days or clicks may. actions
// replaces the whole list.
export interface UpdateAutomationInput {
	name?: string;
	enabled?: boolean;
	trigger?: AutomationTrigger;
	actions?: AutomationAction[];
}

// What the installation can do: without email, email_owner is refused; without destination
// checks, destination_down is refused; without messages (absent counts as false), post_message is
// refused. messages needs an edition sender for another transport than http.
export interface AutomationFeatures {
	email: boolean;
	destinationChecks: boolean;
	messages?: boolean;
}

export function newAutomationId(): string {
	return `aut_${crypto.randomUUID().replaceAll('-', '')}`;
}

export function newAutomationRunId(): string {
	return `run_${crypto.randomUUID().replaceAll('-', '')}`;
}

export function isAutomationResult(value: unknown): value is AutomationResult {
	return typeof value === 'string' && (automationResults as readonly string[]).includes(value);
}

export function isAutomationActionType(value: unknown): value is AutomationActionType {
	return typeof value === 'string' && (automationActionTypes as readonly string[]).includes(value);
}

export function isAutomationTriggerType(value: unknown): value is AutomationTriggerType {
	return typeof value === 'string' && (automationTriggerTypes as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isOptionalText = (value: unknown) => value === null || typeof value === 'string';
const isCount = (value: unknown) =>
	typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function isTrigger(value: unknown): value is AutomationTrigger {
	if (!isRecord(value)) return false;
	if (value.type === 'link_age') return isCount(value.days);
	if (value.type === 'clicks') return isCount(value.clicks);
	return value.type === 'end_date' || value.type === 'destination_down';
}

function isAction(value: unknown): value is AutomationAction {
	if (!isRecord(value)) return false;
	if (value.type === 'change_destination') return typeof value.destination === 'string';
	if (value.type === 'send_webhook' || value.type === 'post_message')
		return typeof value.endpointId === 'string';
	return value.type === 'disable_link' || value.type === 'email_owner';
}

export function isAutomation(value: unknown): value is Automation {
	return (
		isRecord(value) &&
		typeof value.id === 'string' &&
		typeof value.name === 'string' &&
		typeof value.enabled === 'boolean' &&
		isTrigger(value.trigger) &&
		Array.isArray(value.actions) &&
		value.actions.every(isAction) &&
		isCount(value.links) &&
		typeof value.createdAt === 'string' &&
		typeof value.updatedAt === 'string'
	);
}

export function isAutomationPage(value: unknown): value is AutomationPage {
	return (
		isRecord(value) &&
		Array.isArray(value.automations) &&
		value.automations.every(isAutomation) &&
		isCount(value.used) &&
		isCount(value.limit) &&
		Array.isArray(value.actionTypes) &&
		value.actionTypes.every(isAutomationActionType) &&
		Array.isArray(value.triggerTypes) &&
		value.triggerTypes.every(isAutomationTriggerType) &&
		value.perLinkLimit === automationsPerLink
	);
}

function isLinkAutomation(value: unknown): value is LinkAutomation {
	if (!isRecord(value)) return false;
	const check = value.check;
	return (
		typeof value.automationId === 'string' &&
		typeof value.name === 'string' &&
		typeof value.enabled === 'boolean' &&
		isTrigger(value.trigger) &&
		(value.state === 'waiting' ||
			value.state === 'done' ||
			value.state === 'failed' ||
			value.state === 'skipped') &&
		isOptionalText(value.endsAt) &&
		isOptionalText(value.dueAt) &&
		isOptionalText(value.firedAt) &&
		(value.result === null || isAutomationResult(value.result)) &&
		typeof value.appliedAt === 'string' &&
		(check === null ||
			(isRecord(check) &&
				isOptionalText(check.lastCheckedAt) &&
				isOptionalText(check.lastResult) &&
				isCount(check.failures)))
	);
}

export function isLinkAutomationPage(value: unknown): value is LinkAutomationPage {
	return (
		isRecord(value) &&
		typeof value.linkId === 'string' &&
		Array.isArray(value.automations) &&
		value.automations.every(isLinkAutomation)
	);
}

export function isApplyLinkAutomationResult(value: unknown): value is ApplyLinkAutomationResult {
	return (
		isLinkAutomationPage(value) &&
		isRecord(value) &&
		(value.status === 'applied' || value.status === 'unchanged')
	);
}

function isApplyResult(value: unknown): value is ApplyAutomationLinkResult {
	if (!isRecord(value) || typeof value.linkId !== 'string') return false;
	if (value.status === 'failed')
		return (
			isRecord(value.error) &&
			isErrorCode(value.error.code) &&
			typeof value.error.message === 'string'
		);
	return value.status === 'applied' || value.status === 'unchanged';
}

export function isApplyAutomationLinksResult(value: unknown): value is ApplyAutomationLinksResult {
	return isRecord(value) && Array.isArray(value.results) && value.results.every(isApplyResult);
}

function isAutomationRun(value: unknown): value is AutomationRun {
	return (
		isRecord(value) &&
		typeof value.id === 'string' &&
		typeof value.linkId === 'string' &&
		isOptionalText(value.shortUrl) &&
		(value.state === 'succeeded' || value.state === 'failed' || value.state === 'skipped') &&
		(value.result === null || isAutomationResult(value.result)) &&
		Array.isArray(value.actions) &&
		value.actions.every(isAutomationActionType) &&
		typeof value.createdAt === 'string'
	);
}

export function isAutomationRunPage(value: unknown): value is AutomationRunPage {
	return isRecord(value) && Array.isArray(value.runs) && value.runs.every(isAutomationRun);
}

function record(value: unknown, field = 'body'): Record<string, unknown> {
	if (!isRecord(value))
		throw new LinkInputError(field, field === 'body' ? 'Send a JSON object.' : 'Use an object.');
	return value;
}

function onlyFields(body: Record<string, unknown>, allowed: string[]): void {
	for (const key of Object.keys(body))
		if (!allowed.includes(key)) throw new LinkInputError(key, `Unknown field "${key}".`);
}

// Printable ASCII only, so an ID is safe to store, compare, and log.
export function parseAutomationId(value: unknown, field: string): string {
	if (
		typeof value !== 'string' ||
		!value ||
		value.length > maxAutomationIdLength ||
		!/^[\x21-\x7e]+$/.test(value)
	)
		throw new LinkInputError(field, 'Use an ID that the API returned.');
	return value;
}

// Trimmed, with each run of whitespace made one space: 1 to 80 characters and no control
// characters.
export function parseAutomationName(value: unknown): string {
	const name = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
	if (!name || [...name].length > automationNameMaxLength)
		throw new LinkInputError('name', `Use a name of 1 to ${automationNameMaxLength} characters.`);
	if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(name))
		throw new LinkInputError('name', 'Remove control characters.');
	return name;
}

function parseTrigger(value: unknown, features: AutomationFeatures): AutomationTrigger {
	const body = record(value, 'trigger');
	if (!isAutomationTriggerType(body.type))
		throw new LinkInputError('trigger', 'Choose when the automation runs.');
	switch (body.type) {
		case 'link_age': {
			onlyFields(body, ['type', 'days']);
			const days = body.days;
			if (
				typeof days !== 'number' ||
				!Number.isSafeInteger(days) ||
				days < minTriggerDays ||
				days > maxTriggerDays
			)
				throw new LinkInputError('trigger', 'Use a whole number of days from 1 to 3,650.');
			return { type: 'link_age', days };
		}
		case 'clicks': {
			onlyFields(body, ['type', 'clicks']);
			const clicks = body.clicks;
			if (
				typeof clicks !== 'number' ||
				!Number.isSafeInteger(clicks) ||
				clicks < minTriggerClicks ||
				clicks > maxTriggerClicks ||
				clicks % triggerClickStep !== 0
			)
				throw new LinkInputError(
					'trigger',
					'Use a multiple of 100 clicks from 100 to 100,000,000.'
				);
			return { type: 'clicks', clicks };
		}
		case 'destination_down':
			onlyFields(body, ['type']);
			if (!features.destinationChecks)
				throw new LinkInputError('trigger', 'This installation does not check destinations.');
			return { type: 'destination_down' };
		case 'end_date':
			onlyFields(body, ['type']);
			return { type: 'end_date' };
	}
}

function parseAction(value: unknown, features: AutomationFeatures): AutomationAction {
	const body = record(value, 'actions');
	if (!isAutomationActionType(body.type))
		throw new LinkInputError('actions', 'Choose what the automation does.');
	switch (body.type) {
		case 'change_destination':
			onlyFields(body, ['type', 'destination']);
			return { type: 'change_destination', destination: parseDestination(body.destination) };
		case 'send_webhook':
			onlyFields(body, ['type', 'endpointId']);
			return { type: 'send_webhook', endpointId: parseAutomationId(body.endpointId, 'endpointId') };
		case 'post_message':
			onlyFields(body, ['type', 'endpointId']);
			if (features.messages !== true)
				throw new LinkInputError('actions', 'This installation does not post messages.');
			return { type: 'post_message', endpointId: parseAutomationId(body.endpointId, 'endpointId') };
		case 'email_owner':
			onlyFields(body, ['type']);
			if (!features.email)
				throw new LinkInputError('actions', 'This installation does not send email.');
			return { type: 'email_owner' };
		case 'disable_link':
			onlyFields(body, ['type']);
			return { type: 'disable_link' };
	}
}

// One to five actions, each kind at most once, returned in the order they run.
function parseActions(value: unknown, features: AutomationFeatures): AutomationAction[] {
	if (!Array.isArray(value) || value.length === 0)
		throw new LinkInputError('actions', 'Choose at least one action.');
	const actions = value.map((action) => parseAction(action, features));
	const order = (action: AutomationAction) => automationActionTypes.indexOf(action.type);
	if (new Set(actions.map((action) => action.type)).size !== actions.length)
		throw new LinkInputError('actions', 'Use each action at most once.');
	return actions.sort((a, b) => order(a) - order(b));
}

export function parseCreateAutomation(
	value: unknown,
	features: AutomationFeatures
): CreateAutomationInput {
	const body = record(value);
	onlyFields(body, ['name', 'trigger', 'actions']);
	return {
		name: parseAutomationName(body.name),
		trigger: parseTrigger(body.trigger, features),
		actions: parseActions(body.actions, features)
	};
}

export function parseUpdateAutomation(
	value: unknown,
	features: AutomationFeatures
): UpdateAutomationInput {
	const body = record(value);
	onlyFields(body, ['name', 'enabled', 'trigger', 'actions']);
	const update: UpdateAutomationInput = {};
	if (body.name !== undefined) update.name = parseAutomationName(body.name);
	if (body.enabled !== undefined) {
		if (typeof body.enabled !== 'boolean')
			throw new LinkInputError('enabled', 'Use true or false.');
		update.enabled = body.enabled;
	}
	if (body.trigger !== undefined) update.trigger = parseTrigger(body.trigger, features);
	if (body.actions !== undefined) update.actions = parseActions(body.actions, features);
	if (Object.keys(update).length === 0)
		throw new LinkInputError(
			'body',
			'Change the name, the enabled state, the trigger, or the actions.'
		);
	return update;
}

const isoWithOffset =
	/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

// ISO 8601 with an offset, at most automationEndsAtRangeMs from now. Returned in UTC.
function parseEndsAt(value: unknown, now: number): string | undefined {
	if (value === undefined || value === null) return undefined;
	const time = typeof value === 'string' && isoWithOffset.test(value) ? Date.parse(value) : NaN;
	if (!Number.isFinite(time))
		throw new LinkInputError(
			'endsAt',
			'Use a date and time with an offset, such as 2026-11-01T09:00:00Z.'
		);
	if (Math.abs(time - now) > automationEndsAtRangeMs)
		throw new LinkInputError('endsAt', 'Use a date within 10 years.');
	return new Date(time).toISOString();
}

// The body of PUT /v1/links/{id}/automations/{automationId}. Whether endsAt fits the template is
// checked against it with automationEndsAt.
export function parseApplyAutomation(value: unknown, now: number): ApplyAutomationInput {
	const body = value === undefined || value === null ? {} : record(value);
	onlyFields(body, ['endsAt']);
	const endsAt = parseEndsAt(body.endsAt, now);
	return endsAt === undefined ? {} : { endsAt };
}

// The body of POST /v1/automations/{id}/links. Repeated link IDs count once, in their first
// place. More than maxApplyLinks throws ImportRequestError with TOO_MANY_ITEMS.
export function parseApplyAutomationLinks(value: unknown, now: number): ApplyAutomationLinksInput {
	const body = record(value);
	onlyFields(body, ['linkIds', 'endsAt']);
	if (!Array.isArray(body.linkIds) || body.linkIds.length === 0)
		throw new LinkInputError('linkIds', 'Send linkIds as a list of link IDs.');
	if (body.linkIds.length > maxApplyLinks)
		throw new ImportRequestError(
			'TOO_MANY_ITEMS',
			'linkIds',
			`Send at most ${maxApplyLinks} link IDs in one request.`
		);
	const linkIds = [...new Set(body.linkIds.map((id) => parseAutomationId(id, 'linkIds')))];
	const endsAt = parseEndsAt(body.endsAt, now);
	return endsAt === undefined ? { linkIds } : { linkIds, endsAt };
}

// An end date is required by an end_date template and refused by the others. Returns it in
// milliseconds, or null.
export function automationEndsAt(
	trigger: AutomationTriggerType,
	input: ApplyAutomationInput
): number | null {
	if (trigger !== 'end_date') {
		if (input.endsAt !== undefined)
			throw new LinkInputError('endsAt', 'Only an end date automation takes an end date.');
		return null;
	}
	if (input.endsAt === undefined)
		throw new LinkInputError('endsAt', 'Choose the date and time the automation runs.');
	return Date.parse(input.endsAt);
}
