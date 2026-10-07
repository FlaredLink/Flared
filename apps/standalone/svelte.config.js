// SPDX-License-Identifier: AGPL-3.0-only
import adapter from '@sveltejs/adapter-cloudflare';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		adapter: adapter({
			config: 'wrangler.sveltekit.jsonc',
			platformProxy: { configPath: '../../wrangler.jsonc' }
		}),
		inlineStyleThreshold: 64 * 1024
	}
};
export default config;
