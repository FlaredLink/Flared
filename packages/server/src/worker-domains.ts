// SPDX-License-Identifier: AGPL-3.0-only
// Own domains for a standalone Worker. The operator adds the hostname as a Custom Domain of the
// Worker in the Cloudflare dashboard, so the app holds no Cloudflare token. The Worker serves a
// random challenge on that exact hostname, and a check fetches it back over HTTPS with no
// redirects: a match proves the hostname reaches this Worker. The Worker runs with the
// global_fetch_strictly_public flag, so the fetch reaches only public addresses.
import type { D1Database } from '@cloudflare/workers-types/index.ts';
import { domainClaimLifetimeMs } from '@flared/contracts/domains';
import {
	consumeDomainChallenge,
	deleteDomainChallenges,
	ensureDomainChallenge,
	markDomainChallengeFetched,
	servableDomainChallenge,
	waitingDomains
} from '@flared/data/domain-challenges';
import { recordDomainEvidence, type DomainProvider, type ProviderDomain } from './domains';

export const domainChallengePath = '/.well-known/flared-domain-challenge';
const fetchTimeoutMs = 5000;
const maxChallengeBytes = 1024;

export type ChallengeFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface WorkerDomainDependencies {
	routing: D1Database;
	// Tests replace the network.
	fetch?: ChallengeFetch;
	now?: () => number;
}

function newChallenge(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// The body as text, or null when it is longer than the limit.
async function readSmall(response: Response, limit: number): Promise<string | null> {
	if (!response.body) return '';
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > limit) {
			await reader.cancel();
			return null;
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(bytes);
}

// What the hostname serves at the challenge path over HTTPS, or null for any other answer.
async function fetchChallenge(fetcher: ChallengeFetch, hostname: string): Promise<string | null> {
	try {
		const response = await fetcher(`https://${hostname}${domainChallengePath}`, {
			redirect: 'manual',
			signal: AbortSignal.timeout(fetchTimeoutMs),
			headers: { accept: 'text/plain' }
		});
		if (response.status !== 200) {
			await response.body?.cancel();
			return null;
		}
		return await readSmall(response, maxChallengeBytes);
	} catch {
		return null;
	}
}

export function createWorkerDomainProvider(dependencies: WorkerDomainDependencies): DomainProvider {
	const { routing } = dependencies;
	const now = dependencies.now ?? Date.now;
	const fetcher: ChallengeFetch = dependencies.fetch ?? ((input, init) => fetch(input, init));
	const ensure = (domain: ProviderDomain) =>
		ensureDomainChallenge(routing, {
			domainId: domain.id,
			claimedAt: domain.claimedAt,
			challenge: newChallenge(),
			expiresAt: domain.claimedAt + domainClaimLifetimeMs
		});
	return {
		setup: 'worker_custom_domain',
		records: () => [],
		async start(domain) {
			await ensure(domain);
			return { status: 'waiting' };
		},
		// Until the operator adds the Custom Domain, the hostname serves something else, and the
		// domain keeps waiting until its claim expires.
		async check(domain) {
			const stored = await ensure(domain);
			if (stored.consumed) return { status: 'ready' };
			const claim = { domainId: domain.id, claimedAt: domain.claimedAt };
			const served = await fetchChallenge(fetcher, domain.hostname);
			if (served !== stored.challenge) {
				await markDomainChallengeFetched(routing, claim, now());
				return { status: 'waiting' };
			}
			await consumeDomainChallenge(routing, claim, now());
			return { status: 'ready' };
		},
		// The operator removes the Custom Domain in the dashboard; only the challenges go here.
		async stop(domain) {
			await deleteDomainChallenges(routing, domain.id);
		}
	};
}

// For the scheduled job: checks the waiting domains, least recently fetched first. One domain's
// fault is logged and the run continues.
export async function checkWaitingDomains(
	dependencies: WorkerDomainDependencies & { provider: DomainProvider; limit: number }
): Promise<{ checked: number; failed: number }> {
	const { routing, provider, limit } = dependencies;
	const now = dependencies.now ?? Date.now;
	const result = { checked: 0, failed: 0 };
	for (const domain of await waitingDomains(routing, now(), limit)) {
		try {
			await recordDomainEvidence(routing, domain, await provider.check(domain), now());
			result.checked += 1;
		} catch {
			result.failed += 1;
			console.error(JSON.stringify({ event: 'domain_check_failed', domainId: domain.id }));
		}
	}
	return result;
}

// GET /.well-known/flared-domain-challenge on a link host.
export async function serveDomainChallenge(
	request: Request,
	routing: D1Database,
	now: number
): Promise<Response> {
	if (request.method !== 'GET' && request.method !== 'HEAD')
		return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } });
	const headers = { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' };
	let challenge: string | null;
	try {
		challenge = await servableDomainChallenge(routing, new URL(request.url).hostname, now);
	} catch {
		return new Response('Service unavailable', { status: 503, headers });
	}
	if (challenge === null) return new Response('Not found', { status: 404, headers });
	return new Response(request.method === 'HEAD' ? null : challenge, { headers });
}
