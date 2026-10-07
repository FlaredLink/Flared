// SPDX-License-Identifier: AGPL-3.0-only
import { execSync } from 'node:child_process';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// The commit this build comes from, for the source code link (AGPL section 13). Workers Builds
// sets WORKERS_CI_COMMIT_SHA; a local build asks Git.
function commit(): string {
	const ci = process.env.WORKERS_CI_COMMIT_SHA;
	if (ci && /^[0-9a-f]{7,40}$/.test(ci)) return ci;
	try {
		const head = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
		return /^[0-9a-f]{40}$/.test(head) ? head : '';
	} catch {
		return '';
	}
}

export default defineConfig({
	plugins: [sveltekit()],
	define: { __FLARED_COMMIT__: JSON.stringify(commit()) }
});
