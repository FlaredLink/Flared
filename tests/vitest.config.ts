// SPDX-License-Identifier: AGPL-3.0-only
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';
export default defineConfig(async () => ({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: './tests/wrangler.jsonc' },
			miniflare: {
				bindings: {
					PROBE_BASELINE: process.env.FLARED_PROBE_BASELINE === '1',
					IDENTITY_MIGRATIONS: await readD1Migrations('packages/data/migrations/identity'),
					ROUTING_MIGRATIONS: await readD1Migrations('packages/data/migrations/routing')
				}
			}
		})
	],
	test: { include: ['tests/**/*.test.ts'], fileParallelism: false, testTimeout: 30000 }
}));
