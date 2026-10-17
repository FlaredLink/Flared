// SPDX-License-Identifier: AGPL-3.0-only
// Browser calls to the automation routes of the /v1 API over the dashboard session. The page
// passes its API base path, and the browser sends the session cookie and its Origin with each
// change. Each response is checked at run time: a body of the wrong shape counts as a failed
// request.
import {
	automationsPerLink,
	isApplyAutomationLinksResult,
	isApplyLinkAutomationResult,
	isAutomation,
	isAutomationPage,
	isAutomationRunPage,
	isLinkAutomationPage,
	type ApplyAutomationLinksResult,
	type Automation,
	type AutomationAction,
	type AutomationPage,
	type AutomationRun,
	type CreateAutomationInput,
	type LinkAutomation,
	type UpdateAutomationInput
} from '@flared/contracts/automations';

export interface AutomationFailure {
	code: string;
	// The API's own message, used when it names the exact problem with the input.
	message: string | null;
	field: string | null;
	retryAfterSeconds: number | null;
}

export type AutomationResult<T> =
	{ ok: true; value: T } | { ok: false; failure: AutomationFailure };

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function failureOf(response: Response): Promise<AutomationFailure> {
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

const failure = (code: string): AutomationFailure => ({
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
): Promise<AutomationResult<T>> {
	let response: Response;
	try {
		response = await fetch(url, init);
	} catch {
		return { ok: false, failure: failure('NETWORK_ERROR') };
	}
	if (response.status !== expected) return { ok: false, failure: await failureOf(response) };
	const body: unknown = expected === 204 ? null : await response.json().catch(() => undefined);
	const value = read(body);
	return value === null
		? { ok: false, failure: failure('SERVICE_UNAVAILABLE') }
		: { ok: true, value };
}

const automationPath = (apiBase: string, id: string) =>
	`${apiBase}/automations/${encodeURIComponent(id)}`;
const linkAutomationsPath = (apiBase: string, linkId: string) =>
	`${apiBase}/links/${encodeURIComponent(linkId)}/automations`;

const json = (method: string, body: unknown, workspace: Record<string, string>): RequestInit => ({
	method,
	headers: { 'content-type': 'application/json', ...workspace },
	body: JSON.stringify(body)
});

export function listAutomations(
	apiBase: string,
	workspace: Record<string, string> = {}
): Promise<AutomationResult<AutomationPage>> {
	return call(`${apiBase}/automations`, { headers: workspace }, 200, (body) =>
		isAutomationPage(body) ? body : null
	);
}

export function createAutomation(
	apiBase: string,
	input: CreateAutomationInput,
	workspace: Record<string, string> = {}
): Promise<AutomationResult<Automation>> {
	return call(`${apiBase}/automations`, json('POST', input, workspace), 201, (body) =>
		record(body) && isAutomation(body.automation) ? body.automation : null
	);
}

export function updateAutomation(
	apiBase: string,
	id: string,
	input: UpdateAutomationInput,
	workspace: Record<string, string> = {}
): Promise<AutomationResult<Automation>> {
	return call(automationPath(apiBase, id), json('PATCH', input, workspace), 200, (body) =>
		record(body) && isAutomation(body.automation) ? body.automation : null
	);
}

export function deleteAutomation(
	apiBase: string,
	id: string,
	workspace: Record<string, string> = {}
): Promise<AutomationResult<true>> {
	return call(
		automationPath(apiBase, id),
		{ method: 'DELETE', headers: workspace },
		204,
		() => true
	);
}

export function listAutomationRuns(
	apiBase: string,
	id: string,
	workspace: Record<string, string> = {}
): Promise<AutomationResult<AutomationRun[]>> {
	return call(`${automationPath(apiBase, id)}/runs`, { headers: workspace }, 200, (body) =>
		isAutomationRunPage(body) ? body.runs : null
	);
}

export function listLinkAutomations(
	apiBase: string,
	linkId: string,
	workspace: Record<string, string> = {}
): Promise<AutomationResult<LinkAutomation[]>> {
	return call(linkAutomationsPath(apiBase, linkId), { headers: workspace }, 200, (body) =>
		isLinkAutomationPage(body) && body.linkId === linkId ? body.automations : null
	);
}

// Applies one template to one link, or re-arms it. Returns the link's automations after it.
export function applyAutomation(
	apiBase: string,
	linkId: string,
	automationId: string,
	endsAt: string | null,
	workspace: Record<string, string> = {}
): Promise<AutomationResult<LinkAutomation[]>> {
	return call(
		`${linkAutomationsPath(apiBase, linkId)}/${encodeURIComponent(automationId)}`,
		json('PUT', endsAt === null ? {} : { endsAt }, workspace),
		200,
		(body) =>
			isApplyLinkAutomationResult(body) && body.linkId === linkId ? body.automations : null
	);
}

export function removeLinkAutomation(
	apiBase: string,
	linkId: string,
	automationId: string,
	workspace: Record<string, string> = {}
): Promise<AutomationResult<true>> {
	return call(
		`${linkAutomationsPath(apiBase, linkId)}/${encodeURIComponent(automationId)}`,
		{ method: 'DELETE', headers: workspace },
		204,
		() => true
	);
}

// Applies one template to up to 100 links. Each link gets its own result.
export function applyAutomationToLinks(
	apiBase: string,
	automationId: string,
	linkIds: string[],
	endsAt: string | null,
	workspace: Record<string, string> = {}
): Promise<AutomationResult<ApplyAutomationLinksResult>> {
	return call(
		`${automationPath(apiBase, automationId)}/links`,
		json('POST', endsAt === null ? { linkIds } : { linkIds, endsAt }, workspace),
		200,
		(body) => (isApplyAutomationLinksResult(body) ? body : null)
	);
}

const sameAction = (a: AutomationAction, b: AutomationAction): boolean =>
	JSON.stringify(a) === JSON.stringify(b);

// The fields of an edit that differ from the template, for a PATCH that sends only those.
export function automationChanges(
	automation: Automation,
	input: CreateAutomationInput
): UpdateAutomationInput {
	const changes: UpdateAutomationInput = {};
	if (input.name !== automation.name) changes.name = input.name;
	if (JSON.stringify(input.trigger) !== JSON.stringify(automation.trigger))
		changes.trigger = input.trigger;
	const sameActions =
		input.actions.length === automation.actions.length &&
		input.actions.every((action) => automation.actions.some((item) => sameAction(item, action)));
	if (!sameActions) changes.actions = input.actions;
	return changes;
}

// The value of a datetime-local field, read in the viewer's time zone, as ISO 8601 in UTC.
export function localDateTimeToIso(value: string): string | null {
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value)) return null;
	const time = new Date(value).getTime();
	return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

// An ISO time as the value of a datetime-local field in the viewer's time zone.
export function isoToLocalDateTime(iso: string): string {
	const date = new Date(iso);
	if (!Number.isFinite(date.getTime())) return '';
	const pad = (value: number) => String(value).padStart(2, '0');
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// What went wrong with a request, in plain words.
export function automationErrorMessage(failure: AutomationFailure): string {
	switch (failure.code) {
		case 'AUTOMATION_LIMIT_REACHED':
			return (
				failure.message ??
				'You have reached the automation limit. Delete an automation before you add another.'
			);
		case 'LINK_AUTOMATION_LIMIT_REACHED':
			return `A link keeps up to ${automationsPerLink} automations. Remove one from the link first.`;
		// The API names the exact problem with the field.
		case 'INVALID_INPUT':
			return failure.message ?? 'Check the fields and try again.';
		case 'LINK_BLOCKED':
			return 'Flared blocked this link for abuse. You can only turn it off.';
		case 'OWNER_REQUIRED':
			return 'Only the workspace owner can create or change automations.';
		case 'INSUFFICIENT_SCOPE':
			return 'You do not have access to change automations.';
		case 'NOT_FOUND':
			return 'This automation or link no longer exists. Reload the page.';
		case 'RATE_LIMITED': {
			const minutes = Math.ceil((failure.retryAfterSeconds ?? 60) / 60);
			return `Too many changes for now. Try again in ${minutes === 1 ? '1 minute' : `${minutes} minutes`}.`;
		}
		case 'WORKSPACE_CHANGED':
			return 'You switched workspaces in another tab. Reload the page to continue.';
		case 'WORKSPACE_SUSPENDED':
			return 'Flared suspended this workspace. You can still remove automations.';
		case 'UNAUTHENTICATED':
			return 'Your session ended. Sign in again.';
		case 'NETWORK_ERROR':
			return 'We could not reach Flared. Check your connection and try again.';
		default:
			return 'Something went wrong. Try again.';
	}
}
