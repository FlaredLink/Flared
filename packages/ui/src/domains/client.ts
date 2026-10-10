// SPDX-License-Identifier: AGPL-3.0-only
// Browser calls to the domain routes of the /v1 API. The page passes its API base path, and the
// browser sends the session cookie and its Origin with each change.
import { isDomain, type Domain } from '@flared/contracts/domains';

export interface DomainFailure {
	code: string;
	// The API's own message, used when it names the exact problem with the input.
	message: string | null;
	field: string | null;
	retryAfterSeconds: number | null;
}

export type DomainResult<T> = { ok: true; value: T } | { ok: false; failure: DomainFailure };

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const unavailable: DomainFailure = {
	code: 'SERVICE_UNAVAILABLE',
	message: null,
	field: null,
	retryAfterSeconds: null
};

async function failureOf(response: Response): Promise<DomainFailure> {
	const body: unknown = await response.json().catch(() => null);
	const error = record(body) && record(body.error) ? body.error : {};
	const retryAfter = Number(response.headers.get('retry-after'));
	return {
		code: typeof error.code === 'string' ? error.code : 'SERVICE_UNAVAILABLE',
		message: typeof error.message === 'string' ? error.message : null,
		field: typeof error.field === 'string' ? error.field : null,
		retryAfterSeconds: Number.isSafeInteger(retryAfter) && retryAfter > 0 ? retryAfter : null
	};
}

async function domainOf(response: Response): Promise<DomainResult<Domain>> {
	const body: unknown = await response.json().catch(() => null);
	return record(body) && isDomain(body.domain)
		? { ok: true, value: body.domain }
		: { ok: false, failure: unavailable };
}

export async function addDomain(
	apiBase: string,
	hostname: string,
	workspace: Record<string, string> = {}
): Promise<DomainResult<Domain>> {
	try {
		const response = await fetch(`${apiBase}/domains`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', ...workspace },
			body: JSON.stringify({ hostname })
		});
		// 200 means the workspace already has this hostname, which is success for the person.
		if (response.status !== 201 && response.status !== 200)
			return { ok: false, failure: await failureOf(response) };
		return await domainOf(response);
	} catch {
		return { ok: false, failure: unavailable };
	}
}

export async function checkDomain(
	apiBase: string,
	id: string,
	workspace: Record<string, string> = {}
): Promise<DomainResult<Domain>> {
	try {
		const response = await fetch(`${apiBase}/domains/${encodeURIComponent(id)}/check`, {
			method: 'POST',
			headers: workspace
		});
		if (!response.ok) return { ok: false, failure: await failureOf(response) };
		return await domainOf(response);
	} catch {
		return { ok: false, failure: unavailable };
	}
}

export async function removeDomain(
	apiBase: string,
	id: string,
	workspace: Record<string, string> = {}
): Promise<DomainResult<null>> {
	try {
		const response = await fetch(`${apiBase}/domains/${encodeURIComponent(id)}`, {
			method: 'DELETE',
			headers: workspace
		});
		return response.status === 204
			? { ok: true, value: null }
			: { ok: false, failure: await failureOf(response) };
	} catch {
		return { ok: false, failure: unavailable };
	}
}

function seconds(value: number): string {
	return value === 1 ? '1 second' : `${value} seconds`;
}

export function domainErrorMessage(failure: DomainFailure): string {
	switch (failure.code) {
		// The API names the exact hostname problem, with the same rules as this form.
		case 'INVALID_INPUT':
			return failure.message ?? 'Enter a hostname such as go.example.com.';
		case 'DOMAIN_TAKEN':
			return failure.message ?? 'This hostname is already in use.';
		case 'DOMAIN_LIMIT_REACHED':
			return 'You have used all your custom domains. Remove a domain to add another.';
		case 'DOMAINS_UNAVAILABLE':
			return 'Custom domains are not available right now. Try again later.';
		case 'DOMAIN_CHECK_TOO_SOON':
			return failure.retryAfterSeconds
				? `This domain was checked a moment ago. Try again in ${seconds(failure.retryAfterSeconds)}.`
				: 'This domain was checked a moment ago. Try again in a minute.';
		case 'RATE_LIMITED':
			return 'You are adding domains too quickly. Wait a minute and try again.';
		case 'NOT_FOUND':
			return 'This domain was already removed.';
		case 'UNAUTHENTICATED':
			return 'Your session ended. Sign in again.';
		case 'WORKSPACE_CHANGED':
			return 'You switched workspaces in another tab. Reload the page to continue.';
		default:
			return 'Something went wrong. Try again.';
	}
}
