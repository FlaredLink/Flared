// SPDX-License-Identifier: AGPL-3.0-only
import { defaultSourceUrl } from '$lib/source';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ platform, setHeaders }) => {
	setHeaders({
		'Cache-Control': 'no-store',
		'X-Robots-Tag': 'noindex, nofollow',
		'Referrer-Policy': 'no-referrer',
		// Setup, sign-in, consent, and settings must not be framed by another site.
		'Content-Security-Policy': "frame-ancestors 'none'",
		'X-Frame-Options': 'DENY'
	});
	return {
		installation: platform?.env.INSTALLATION ?? { state: 'misconfigured' as const, moving: false },
		sourceUrl: platform?.env.SOURCE_URL ?? defaultSourceUrl
	};
};
