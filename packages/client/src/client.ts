// SPDX-License-Identifier: AGPL-3.0-only
// Typed client for the /v1 API, shared by the CLI and the MCP server. It runs in Node.js,
// browsers, and Workers: it uses only fetch and never imports server modules.
import {
	isLinkAnalytics,
	isUsage,
	type LinkAnalytics,
	type Usage
} from '@flared/contracts/analytics';
import { isErrorCode, type ErrorCode } from '@flared/contracts/errors';
import { isLink, isLinkPage, type Link, type LinkPage } from '@flared/contracts/links';
import { isApiIdentity, type ApiIdentity } from '@flared/contracts/tokens';

export const defaultApiUrl = 'https://api.flared.page/v1';

// NETWORK_ERROR: no response arrived. INVALID_RESPONSE: the response had an unexpected shape.
export type ClientErrorCode = ErrorCode | 'NETWORK_ERROR' | 'INVALID_RESPONSE';

export class FlaredApiError extends Error {
	constructor(
		readonly code: ClientErrorCode,
		message: string,
		readonly status: number | null,
		readonly requestId: string | null = null,
		readonly retryAfterSeconds: number | null = null,
		readonly field: string | null = null
	) {
		super(message);
		this.name = 'FlaredApiError';
	}
}

export interface ClientOptions {
	// The API base, such as https://api.flared.page/v1. HTTPS is required except on loopback.
	baseUrl: string;
	token: string;
	fetch?: typeof fetch;
	userAgent?: string;
	// Retries after 429, 503, or a network error; only for reads and keyed creates. Default 2.
	retries?: number;
	sleep?: (milliseconds: number) => Promise<void>;
}

export interface CreateLinkRequest {
	destination: string;
	slug?: string;
	title?: string;
	domainId?: string;
	// Reuse the same key to retry a create safely; a new one is generated when it is absent.
	idempotencyKey?: string;
}

export interface UpdateLinkRequest {
	destination?: string;
	title?: string | null;
	enabled?: boolean;
}

export interface ListLinksRequest {
	limit?: number;
	cursor?: string;
	search?: string;
}

export interface FlaredClient {
	me(): Promise<ApiIdentity>;
	createLink(request: CreateLinkRequest): Promise<{ link: Link; replayed: boolean }>;
	listLinks(request?: ListLinksRequest): Promise<LinkPage>;
	getLink(id: string): Promise<Link>;
	updateLink(id: string, change: UpdateLinkRequest): Promise<Link>;
	getAnalytics(id: string, range?: { from?: string; to?: string }): Promise<LinkAnalytics>;
	getUsage(): Promise<Usage>;
}

const maxRetryWaitSeconds = 30;

export function normalizeBaseUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error('Use an absolute API URL, such as https://api.flared.page/v1.');
	}
	const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
	if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
		throw new Error('Use an HTTPS API URL. Plain HTTP is allowed only for localhost.');
	if (url.username || url.password || url.search || url.hash)
		throw new Error('Use an API URL without credentials, query, or fragment.');
	return url.href.replace(/\/+$/, '');
}

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function retryAfter(response: Response): number | null {
	const header = response.headers.get('retry-after');
	const seconds = header === null || header.trim() === '' ? NaN : Number(header);
	return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds) : null;
}

async function failure(response: Response): Promise<FlaredApiError> {
	const body = record(await response.json().catch(() => null));
	const error = record(body?.error);
	const code = isErrorCode(error?.code) ? error.code : null;
	return new FlaredApiError(
		code ?? (response.status >= 500 ? 'SERVICE_UNAVAILABLE' : 'INVALID_RESPONSE'),
		typeof error?.message === 'string' ? error.message : `The API answered ${response.status}.`,
		response.status,
		typeof error?.requestId === 'string' ? error.requestId : null,
		retryAfter(response),
		typeof error?.field === 'string' ? error.field : null
	);
}

function invalid(status: number): FlaredApiError {
	return new FlaredApiError('INVALID_RESPONSE', 'The API sent an unexpected response.', status);
}

export function createClient(options: ClientOptions): FlaredClient {
	const baseUrl = normalizeBaseUrl(options.baseUrl);
	const send = options.fetch ?? fetch;
	const retries = options.retries ?? 2;
	const sleep =
		options.sleep ?? ((milliseconds) => new Promise((done) => setTimeout(done, milliseconds)));

	async function request(
		method: string,
		path: string,
		init: { body?: unknown; headers?: Record<string, string>; retry: boolean }
	): Promise<{ status: number; headers: Headers; body: unknown }> {
		const headers = new Headers(init.headers);
		headers.set('authorization', `Bearer ${options.token}`);
		headers.set('accept', 'application/json');
		if (options.userAgent) headers.set('user-agent', options.userAgent);
		if (init.body !== undefined) headers.set('content-type', 'application/json');
		for (let attempt = 0; ; attempt += 1) {
			let response: Response;
			try {
				response = await send(`${baseUrl}${path}`, {
					method,
					headers,
					body: init.body === undefined ? undefined : JSON.stringify(init.body)
				});
			} catch {
				if (init.retry && attempt < retries) {
					await sleep(1000 * 2 ** attempt);
					continue;
				}
				throw new FlaredApiError('NETWORK_ERROR', 'Could not reach the Flared API.', null);
			}
			if (response.ok) {
				const body: unknown = await response.json().catch(() => undefined);
				if (body === undefined) throw invalid(response.status);
				return { status: response.status, headers: response.headers, body };
			}
			const error = await failure(response);
			const transient = response.status === 429 || response.status === 503;
			const wait = error.retryAfterSeconds ?? 2 ** attempt;
			if (init.retry && transient && attempt < retries && wait <= maxRetryWaitSeconds) {
				await sleep(wait * 1000);
				continue;
			}
			throw error;
		}
	}

	const id = (value: string) => encodeURIComponent(value);
	async function linkFrom(promise: ReturnType<typeof request>): Promise<Link> {
		const { status, body } = await promise;
		const link = record(body)?.link;
		if (!isLink(link)) throw invalid(status);
		return link;
	}

	return {
		async me() {
			const { status, body } = await request('GET', '/me', { retry: true });
			if (!isApiIdentity(body)) throw invalid(status);
			return body;
		},
		async createLink({ idempotencyKey, ...input }) {
			const key = idempotencyKey ?? crypto.randomUUID();
			const response = await request('POST', '/links', {
				body: input,
				headers: { 'idempotency-key': key },
				retry: true
			});
			const link = record(response.body)?.link;
			if (!isLink(link)) throw invalid(response.status);
			return { link, replayed: response.headers.get('idempotent-replayed') === 'true' };
		},
		async listLinks(query = {}) {
			const params = new URLSearchParams();
			if (query.limit !== undefined) params.set('limit', String(query.limit));
			if (query.cursor) params.set('cursor', query.cursor);
			if (query.search) params.set('q', query.search);
			const suffix = params.size ? `?${params}` : '';
			const { status, body } = await request('GET', `/links${suffix}`, { retry: true });
			if (!isLinkPage(body)) throw invalid(status);
			return body;
		},
		getLink(linkId) {
			return linkFrom(request('GET', `/links/${id(linkId)}`, { retry: true }));
		},
		updateLink(linkId, change) {
			return linkFrom(request('PATCH', `/links/${id(linkId)}`, { body: change, retry: false }));
		},
		async getAnalytics(linkId, range = {}) {
			const params = new URLSearchParams();
			if (range.from) params.set('from', range.from);
			if (range.to) params.set('to', range.to);
			const suffix = params.size ? `?${params}` : '';
			const { status, body } = await request('GET', `/links/${id(linkId)}/analytics${suffix}`, {
				retry: true
			});
			const analytics = record(body)?.analytics;
			if (!isLinkAnalytics(analytics)) throw invalid(status);
			return analytics;
		},
		async getUsage() {
			const { status, body } = await request('GET', '/usage', { retry: true });
			const usage = record(body)?.usage;
			if (!isUsage(usage)) throw invalid(status);
			return usage;
		}
	};
}
