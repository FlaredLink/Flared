// SPDX-License-Identifier: AGPL-3.0-only
// Stands in for the adapter output so the Worker entry can be tested without a build.
export const calls: { request: Request; env: Record<string, unknown> }[] = [];

export default {
	async fetch(request: Request, env: Record<string, unknown>): Promise<Response> {
		calls.push({ request, env });
		return new Response('sveltekit', { headers: { 'content-type': 'text/html' } });
	}
};
