// SPDX-License-Identifier: AGPL-3.0-only
// Exit codes are part of the CLI's public contract. Do not renumber them.
import type { ClientErrorCode } from '@flared/client';

export const exitCodes = {
	ok: 0,
	failure: 1,
	usage: 2,
	unauthenticated: 3,
	forbidden: 4,
	notFound: 5,
	rejected: 6,
	planLimit: 7,
	rateLimited: 8,
	unavailable: 9
} as const;

export function exitCodeFor(code: ClientErrorCode): number {
	switch (code) {
		case 'UNAUTHENTICATED':
			return exitCodes.unauthenticated;
		case 'INSUFFICIENT_SCOPE':
		case 'NO_WORKSPACE':
		case 'ACCOUNT_DELETING':
		case 'WORKSPACE_SUSPENDED':
		case 'LINK_BLOCKED':
		case 'ORIGIN_REJECTED':
		case 'REAUTH_REQUIRED':
			return exitCodes.forbidden;
		case 'NOT_FOUND':
			return exitCodes.notFound;
		case 'INVALID_INPUT':
		case 'SLUG_TAKEN':
		case 'IDEMPOTENCY_KEY_REUSED':
		case 'IDEMPOTENCY_KEY_REQUIRED':
		case 'DEFAULT_DOMAIN_UNAVAILABLE':
		case 'DOMAIN_UNAVAILABLE':
		case 'DOMAIN_TAKEN':
			return exitCodes.rejected;
		case 'PLAN_LIMIT_REACHED':
		case 'TOKEN_LIMIT_REACHED':
		case 'DOMAIN_LIMIT_REACHED':
			return exitCodes.planLimit;
		case 'RATE_LIMITED':
		case 'DOMAIN_CHECK_TOO_SOON':
			return exitCodes.rateLimited;
		case 'SERVICE_UNAVAILABLE':
		case 'DOMAINS_UNAVAILABLE':
		case 'WORKSPACE_PENDING':
		case 'NETWORK_ERROR':
			return exitCodes.unavailable;
		default:
			return exitCodes.failure;
	}
}

// A mistake in the command line itself.
export class UsageError extends Error {}

// A local problem the person can fix, with its own exit code.
export class CliError extends Error {
	constructor(
		message: string,
		readonly exitCode: number,
		readonly code = 'CLI_ERROR'
	) {
		super(message);
	}
}
