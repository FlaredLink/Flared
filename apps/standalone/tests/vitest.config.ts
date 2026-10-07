// SPDX-License-Identifier: AGPL-3.0-only
import { fileURLToPath } from 'node:url';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

const migrations = (store: string) =>
	readD1Migrations(
		fileURLToPath(new URL(`../../../packages/data/migrations/${store}`, import.meta.url))
	);

export default defineConfig(async () => ({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: fileURLToPath(new URL('./wrangler.jsonc', import.meta.url)) },
			miniflare: {
				bindings: {
					IDENTITY_MIGRATIONS: await migrations('identity'),
					ROUTING_MIGRATIONS: await migrations('routing'),
					ANALYTICS_MIGRATIONS: await migrations('analytics')
				}
			}
		})
	],
	resolve: {
		alias: {
			'sveltekit-worker': fileURLToPath(new URL('./sveltekit-worker.stub.ts', import.meta.url))
		}
	},
	test: {
		include: [fileURLToPath(new URL('./**/*.test.ts', import.meta.url))],
		fileParallelism: false,
		testTimeout: 30000
	}
}));
