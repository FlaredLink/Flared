// SPDX-License-Identifier: AGPL-3.0-only
import type { BetterAuthOptions } from 'better-auth';
export function createSessionOptions(
	origin: string
): Pick<BetterAuthOptions, 'baseURL' | 'trustedOrigins' | 'session' | 'advanced'> {
	const url = new URL(origin);
	if (
		url.origin !== origin ||
		url.username ||
		url.password ||
		!(
			url.protocol === 'https:' ||
			(url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1'))
		)
	) {
		throw new Error('Authentication origin must be an HTTPS origin or explicit loopback origin');
	}
	return {
		baseURL: origin,
		trustedOrigins: [origin],
		session: { expiresIn: 604800, disableSessionRefresh: true, cookieCache: { enabled: false } },
		advanced: {
			useSecureCookies: url.protocol === 'https:',
			defaultCookieAttributes: {
				httpOnly: true,
				secure: url.protocol === 'https:',
				sameSite: 'lax',
				path: '/'
			},
			ipAddress: { disableIpTracking: true }
		}
	};
}
