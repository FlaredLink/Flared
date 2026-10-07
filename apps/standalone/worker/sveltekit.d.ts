// SPDX-License-Identifier: AGPL-3.0-only
// Wrangler aliases this module to the adapter output in .svelte-kit/cloudflare/_worker.js.
declare module 'sveltekit-worker' {
	const worker: {
		fetch(request: Request, env: object, ctx: ExecutionContext): Promise<Response>;
	};
	export default worker;
}
