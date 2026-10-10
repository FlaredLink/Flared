// SPDX-License-Identifier: AGPL-3.0-only
// Stable error codes and HTTP statuses shared by the API and its clients.

export const errorStatus = {
	INVALID_INPUT: 422,
	IDEMPOTENCY_KEY_REQUIRED: 422,
	IDEMPOTENCY_KEY_REUSED: 409,
	SLUG_TAKEN: 409,
	DEFAULT_DOMAIN_UNAVAILABLE: 409,
	DOMAIN_UNAVAILABLE: 422,
	PLAN_LIMIT_REACHED: 403,
	DOMAIN_TAKEN: 409,
	DOMAIN_LIMIT_REACHED: 403,
	DOMAINS_UNAVAILABLE: 503,
	DOMAIN_CHECK_TOO_SOON: 429,
	RATE_LIMITED: 429,
	UNAUTHENTICATED: 401,
	ORIGIN_REJECTED: 403,
	INSUFFICIENT_SCOPE: 403,
	REAUTH_REQUIRED: 403,
	TOKEN_LIMIT_REACHED: 403,
	NO_WORKSPACE: 403,
	WORKSPACE_PENDING: 503,
	ACCOUNT_DELETING: 409,
	WORKSPACE_SUSPENDED: 403,
	// A dashboard tab sent a change for a workspace the session no longer acts in.
	WORKSPACE_CHANGED: 409,
	LINK_BLOCKED: 409,
	NOT_FOUND: 404,
	METHOD_NOT_ALLOWED: 405,
	PAYLOAD_TOO_LARGE: 413,
	UNSUPPORTED_MEDIA_TYPE: 415,
	SERVICE_UNAVAILABLE: 503
} as const;

export type ErrorCode = keyof typeof errorStatus;

export interface ErrorBody {
	// field names the input that failed validation, when one input caused the error.
	error: { code: ErrorCode; message: string; requestId: string; field?: string };
}

export function isErrorCode(value: unknown): value is ErrorCode {
	return typeof value === 'string' && Object.hasOwn(errorStatus, value);
}
