// SPDX-License-Identifier: AGPL-3.0-only
import type { SetupState } from '@flared/data/setup';
import type { AuthService } from '@flared/server/web';

declare global {
	// The commit of this build, or '' (vite.config.ts).
	const __FLARED_COMMIT__: string;
	const __FLARED_VERSION__: string;
	namespace App {
		interface Platform {
			// Set by worker/index.ts for every page.
			env: {
				AUTH_SERVICE?: AuthService;
				API_SERVICE?: AuthService;
				OAUTH_SERVICE?: AuthService;
				LIMITS_SERVICE?: AuthService;
				INSTALLATION?: { state: SetupState; moving: boolean };
				SOURCE_URL?: string;
			};
		}
	}
}
export {};
