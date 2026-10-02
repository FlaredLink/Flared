// SPDX-License-Identifier: AGPL-3.0-only
import { isErrorCode, type ErrorCode } from '@flared/contracts/errors';

// Plain-language messages for the errors a person can act on in the dashboard.
const messages: Partial<Record<ErrorCode, string>> = {
	SLUG_TAKEN: 'That slug is already taken. Try another one.',
	PLAN_LIMIT_REACHED: 'You have reached your active link limit. Disable a link to create another.',
	RATE_LIMITED: 'You are creating links too quickly. Wait a minute and try again.',
	DEFAULT_DOMAIN_UNAVAILABLE: 'Short links are not available right now. Try again soon.',
	WORKSPACE_PENDING: 'Your workspace is still being set up. Try again in a minute.',
	UNAUTHENTICATED: 'Your session ended. Sign in again.'
};

export function linkErrorMessage(code: string, fallback: string): string {
	return (isErrorCode(code) ? messages[code] : undefined) ?? fallback;
}
