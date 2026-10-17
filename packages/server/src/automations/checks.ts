// SPDX-License-Identifier: AGPL-3.0-only
// Destination checks for "destination stops loading" templates. A run claims the applications
// checked longest ago, requests each distinct destination once, and records what it saw. Two
// failed checks in a row of the same destination make the application due.
import type { D1Database } from '@cloudflare/workers-types/index.ts';
import { isWithinHostnames } from '@flared/contracts/domains';
import { publicHostname } from '@flared/contracts/icons';
import {
	claimDestinationChecks,
	finishDestinationChecks,
	type DestinationCheckResult
} from '@flared/data/automations';
import { activeDomainHostnames } from '@flared/data/domains';
import { drain } from '../webhooks/deliver';

// A destination has this long to answer each request.
export const destinationCheckTimeoutMs = 10_000;
// Requests in one check: the destination and up to two redirects.
export const destinationCheckRequests = 3;
// What a check records when a URL on the way may not be requested.
export const notCheckable = 'not_checkable';

export interface DestinationCheckSettings {
	// Applications claimed in one run, at most 100.
	limit: number;
	// Requests at once.
	concurrency: number;
	// Names Flared and a page that explains the checks.
	userAgent: string;
	// The installation's own hostnames. A check never requests them or their subdomains.
	reservedHostnames: readonly string[];
	fetch?: typeof fetch;
}

export interface DestinationCheckSummary {
	claimed: number;
	destinations: number;
	requests: number;
	failed: number;
	notCheckable: number;
}

interface Outcome {
	failed: boolean;
	// An HTTP status such as 404, timeout, network, or not_checkable.
	result: string;
}

interface Probe {
	key: string;
	url: string;
	requests: number;
	outcome: Outcome | null;
}

// The URL a check may request: http or https on the default port, without a user name or
// password, on a public hostname (no IP address, single label, or reserved suffix) that is not
// one of the installation's own hostnames or a subdomain of one. Null for anything else.
export function checkableUrl(
	value: string,
	reservedHostnames: readonly string[]
): { href: string; hostname: string } | null {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return null;
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
	if (url.username || url.password || url.port) return null;
	const hostname = publicHostname(url.hostname);
	if (!hostname || isWithinHostnames(hostname, reservedHostnames)) return null;
	return { href: url.href, hostname };
}

// The first 16 hex digits of the destination's SHA-256: an edited destination counts again from 0.
export async function destinationCheckKey(destination: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(destination));
	return [...new Uint8Array(digest).slice(0, 8)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

type Answer = Outcome | { redirect: string; status: number };

// One request without following redirects. A failure is no answer, 404, 410, or a 5xx other
// than a Cloudflare challenge; every other answer shows the site is up, including 401, 403, 429,
// and the other 4xx.
async function request(url: string, fetcher: typeof fetch, userAgent: string): Promise<Answer> {
	let response: Response;
	try {
		response = await fetcher(url, {
			method: 'GET',
			headers: { 'user-agent': userAgent, accept: '*/*' },
			redirect: 'manual',
			signal: AbortSignal.timeout(destinationCheckTimeoutMs)
		});
	} catch (error) {
		// AbortSignal.timeout rejects with a DOMException named TimeoutError.
		const timedOut =
			typeof error === 'object' && error !== null && Reflect.get(error, 'name') === 'TimeoutError';
		return { failed: true, result: timedOut ? 'timeout' : 'network' };
	}
	await drain(response);
	const { status } = response;
	const result = String(status);
	if (status >= 300 && status < 400) {
		const location = response.headers.get('location');
		if (location) return { redirect: location, status };
		return { failed: false, result };
	}
	if (status === 404 || status === 410) return { failed: true, result };
	if (status >= 500) {
		const challenge = response.headers.get('cf-mitigated')?.trim().toLowerCase() === 'challenge';
		return { failed: !(status === 503 && challenge), result };
	}
	return { failed: false, result };
}

async function inTurn<T>(
	items: readonly T[],
	concurrency: number,
	task: (item: T) => Promise<void>
): Promise<void> {
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const item = items[next];
			next += 1;
			await task(item);
		}
	};
	await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
}

// Each round checks every unfinished destination's next URL, asks the routing store in one
// statement which new hostnames are active Flared domains, and makes the requests. So a check
// takes at most 3 requests and the run at most 3 lookups. Statements: the claim, then 1 to 3
// lookups and the finish when anything was claimed. Logs carry IDs and result codes, never a URL.
export async function checkDestinations(
	stores: { routing: D1Database },
	options: DestinationCheckSettings & { now: number }
): Promise<DestinationCheckSummary> {
	const { routing } = stores;
	if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1)
		throw new Error('Invalid destination check concurrency');
	const claimed = await claimDestinationChecks(routing, { now: options.now, limit: options.limit });
	const summary: DestinationCheckSummary = {
		claimed: claimed.length,
		destinations: 0,
		requests: 0,
		failed: 0,
		notCheckable: 0
	};
	if (claimed.length === 0) return summary;
	// Called as a plain function: the Workers global fetch throws "Illegal invocation" when it
	// runs with another `this`.
	const fetcher: typeof fetch = options.fetch ?? ((input, init) => fetch(input, init));
	const probes = new Map<string, Probe>();
	const probeOf: Probe[] = [];
	for (const check of claimed) {
		let probe = probes.get(check.destination);
		if (!probe) {
			const key = await destinationCheckKey(check.destination);
			probe = { key, url: check.destination, requests: 0, outcome: null };
			probes.set(check.destination, probe);
		}
		probeOf.push(probe);
	}
	summary.destinations = probes.size;
	const activeDomains = new Map<string, boolean>();
	for (let round = 0; round < destinationCheckRequests; round += 1) {
		const targets: { probe: Probe; href: string; hostname: string }[] = [];
		for (const probe of probes.values()) {
			if (probe.outcome) continue;
			const url = checkableUrl(probe.url, options.reservedHostnames);
			if (url) targets.push({ probe, ...url });
			else probe.outcome = { failed: false, result: notCheckable };
		}
		if (targets.length === 0) break;
		const unknown = [
			...new Set(targets.map((target) => target.hostname).filter((h) => !activeDomains.has(h)))
		];
		if (unknown.length > 0) {
			const active = await activeDomainHostnames(routing, unknown);
			for (const hostname of unknown) activeDomains.set(hostname, active.has(hostname));
		}
		const requests = targets.filter((target) => {
			if (!activeDomains.get(target.hostname)) return true;
			target.probe.outcome = { failed: false, result: notCheckable };
			return false;
		});
		await inTurn(requests, options.concurrency, async ({ probe, href }) => {
			const answer = await request(href, fetcher, options.userAgent);
			probe.requests += 1;
			summary.requests += 1;
			if (!('redirect' in answer)) {
				probe.outcome = answer;
				return;
			}
			// A redirect at the last request shows the site answers.
			if (probe.requests >= destinationCheckRequests) {
				probe.outcome = { failed: false, result: String(answer.status) };
				return;
			}
			try {
				probe.url = new URL(answer.redirect, href).href;
			} catch {
				probe.outcome = { failed: false, result: notCheckable };
			}
		});
	}
	// Every probe has an outcome after the last round: its third request ends it.
	const results: DestinationCheckResult[] = claimed.map((check, index) => {
		const probe = probeOf[index];
		const outcome = probe.outcome ?? { failed: false, result: notCheckable };
		return {
			linkId: check.linkId,
			automationId: check.automationId,
			key: probe.key,
			failed: outcome.failed,
			result: outcome.result
		};
	});
	await finishDestinationChecks(routing, { now: options.now, results });
	for (const item of results) {
		if (item.failed) summary.failed += 1;
		if (item.result === notCheckable) summary.notCheckable += 1;
		if (item.failed || item.result === notCheckable)
			console.error(
				JSON.stringify({
					event: 'destination_check',
					linkId: item.linkId,
					automationId: item.automationId,
					result: item.result
				})
			);
	}
	console.log(JSON.stringify({ event: 'destination_checks', ...summary }));
	return summary;
}
