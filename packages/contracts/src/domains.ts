// SPDX-License-Identifier: AGPL-3.0-only
// Short-link domains: states, what the API shows, and the hostname rules for adding one.
import { LinkInputError } from './links';

// pending: added, waiting for DNS. verifying: the record is seen and the certificate is being
// issued. active: serves links. failed: the check gave up or the record disappeared.
// disabled: removed. Only active domains serve links.
export const domainStates = ['pending', 'verifying', 'active', 'failed', 'disabled'] as const;
export type DomainState = (typeof domainStates)[number];

// platform: provided by this installation for every workspace. workspace: added by one.
export type DomainKind = 'platform' | 'workspace';

export const domainFailures = [
	'dns_not_found',
	'record_removed',
	'certificate_failed',
	'blocked',
	'expired',
	'provider_error'
] as const;
export type DomainFailure = (typeof domainFailures)[number];

export const domainFailureMessages: Record<DomainFailure, string> = {
	dns_not_found: 'We could not find the DNS record. Check the record and try again.',
	record_removed: 'The DNS record no longer points to Flared. Add it again.',
	certificate_failed:
		'The HTTPS certificate could not be issued. Check for CAA records that block it.',
	blocked: 'This hostname cannot be used.',
	expired: 'The domain was not set up within 7 days. Remove the domain and add it again.',
	provider_error: 'We could not set up this domain. Check it again in a few minutes.'
};

export function isDomainFailure(value: unknown): value is DomainFailure {
	return typeof value === 'string' && (domainFailures as readonly string[]).includes(value);
}

// An unverified claim keeps the hostname for this long, as Cloudflare keeps retrying.
export const domainClaimLifetimeMs = 7 * 24 * 60 * 60 * 1000;
export const domainCheckIntervalMs = 60 * 1000;

// How a workspace connects a hostname. dns: create the records in Domain.records.
// worker_custom_domain: add the hostname as a Custom Domain of this installation's Worker in the
// Cloudflare dashboard.
export const domainSetups = ['dns', 'worker_custom_domain'] as const;
export type DomainSetup = (typeof domainSetups)[number];

export interface DnsRecord {
	type: 'CNAME';
	name: string;
	value: string;
}

export interface Domain {
	id: string;
	hostname: string;
	kind: DomainKind;
	state: DomainState;
	// The installation default for links created without a domain.
	isDefault: boolean;
	// Null for platform domains and when the installation cannot add domains.
	setup: DomainSetup | null;
	// The records to create; empty for platform domains.
	records: DnsRecord[];
	error: { code: DomainFailure; message: string } | null;
	// Active links on this domain, which stop working when it is removed. Null for platform
	// domains.
	activeLinks: number | null;
	createdAt: string;
	activatedAt: string | null;
}

export interface DomainPage {
	domains: Domain[];
	// Workspace domains that count against the limit (every state except disabled).
	used: number;
	limit: number;
}

export interface AddDomainInput {
	hostname: string;
}

const blockedTopLevels = new Set(['localhost', 'local', 'internal', 'invalid', 'test', 'example']);
const labelPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

// Lowercase ASCII after IDNA conversion. Needs a subdomain such as go.example.com: at least
// three labels, no port, path, wildcard, or IP address.
export function normalizeHostname(value: unknown): string {
	const invalid = (message: string) => new LinkInputError('hostname', message);
	if (typeof value !== 'string' || !value.trim())
		throw invalid('Enter a hostname such as go.example.com.');
	const trimmed = value.trim().toLowerCase().replace(/\.$/, '');
	if (trimmed.length > 253 || /[\s/:?#@[\]*\\%]/.test(trimmed))
		throw invalid('Enter only the hostname, such as go.example.com.');
	let hostname: string;
	try {
		hostname = new URL(`https://${trimmed}`).hostname;
	} catch {
		throw invalid('Enter a valid hostname, such as go.example.com.');
	}
	const labels = hostname.split('.');
	if (!labels.every((label) => labelPattern.test(label)) || hostname.length > 253)
		throw invalid('Enter a valid hostname, such as go.example.com.');
	if (labels.every((label) => /^\d+$/.test(label)) || /^\d+$/.test(labels[labels.length - 1]))
		throw invalid('Use a hostname, not an IP address.');
	if (blockedTopLevels.has(labels[labels.length - 1]))
		throw invalid('Use a hostname on a public domain.');
	if (labels.length < 3)
		throw invalid('Use a subdomain such as go.example.com. Root domains are not supported.');
	return hostname;
}

// True when hostname is one of the given hostnames or a subdomain of one.
export function isWithinHostnames(hostname: string, hostnames: readonly string[]): boolean {
	return hostnames.some((base) => hostname === base || hostname.endsWith(`.${base}`));
}

export function parseAddDomain(body: unknown): AddDomainInput {
	if (typeof body !== 'object' || body === null || Array.isArray(body))
		throw new LinkInputError('body', 'Send a JSON object.');
	const allowed = new Set(['hostname']);
	for (const key of Object.keys(body))
		if (!allowed.has(key)) throw new LinkInputError(key, `Unknown field: ${key}.`);
	return { hostname: normalizeHostname((body as Record<string, unknown>).hostname) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isCount = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;

export function isDomain(value: unknown): value is Domain {
	if (!isRecord(value)) return false;
	const error = value.error;
	return (
		typeof value.id === 'string' &&
		typeof value.hostname === 'string' &&
		(value.kind === 'platform' || value.kind === 'workspace') &&
		(domainStates as readonly unknown[]).includes(value.state) &&
		typeof value.isDefault === 'boolean' &&
		(value.setup === null || (domainSetups as readonly unknown[]).includes(value.setup)) &&
		Array.isArray(value.records) &&
		value.records.every(
			(record) =>
				isRecord(record) &&
				record.type === 'CNAME' &&
				typeof record.name === 'string' &&
				typeof record.value === 'string'
		) &&
		(error === null ||
			(isRecord(error) && isDomainFailure(error.code) && typeof error.message === 'string')) &&
		(value.activeLinks === null || isCount(value.activeLinks)) &&
		typeof value.createdAt === 'string' &&
		(value.activatedAt === null || typeof value.activatedAt === 'string')
	);
}

export function isDomainPage(value: unknown): value is DomainPage {
	return (
		isRecord(value) &&
		Array.isArray(value.domains) &&
		value.domains.every(isDomain) &&
		isCount(value.used) &&
		isCount(value.limit)
	);
}
