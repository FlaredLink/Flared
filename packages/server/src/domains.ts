// SPDX-License-Identifier: AGPL-3.0-only
// Domain product rules on top of the routing store. An edition supplies a provider that
// attaches hostnames and reports evidence; the core decides the states from that evidence.
import type { D1Database } from '@cloudflare/workers-types/index.ts';
import {
	domainCheckIntervalMs,
	domainClaimLifetimeMs,
	domainFailureMessages,
	isWithinHostnames,
	type DnsRecord,
	type Domain,
	type DomainFailure,
	type DomainPage
} from '@flared/contracts/domains';
import {
	applyDomainEvidence,
	claimDomain,
	disableDomain,
	domainUsage,
	findDomain,
	listDomains,
	markDomainChecked,
	type DomainEvidence,
	type DomainRecord
} from '@flared/data/domains';
import { ApiError } from './links';

export type { DomainEvidence } from '@flared/data/domains';

export interface ProviderDomain {
	id: string;
	hostname: string;
	// Identifies this claim of the hostname; a re-add starts a new one.
	claimedAt: number;
}

export interface DomainProvider {
	// The DNS records a workspace creates for the hostname.
	records(hostname: string): DnsRecord[];
	// Attaches the hostname. Must be safe to repeat for the same claim.
	start(domain: ProviderDomain): Promise<DomainEvidence>;
	check(domain: ProviderDomain): Promise<DomainEvidence>;
	// Detaches the hostname. Must be safe to repeat.
	stop(domain: ProviderDomain): Promise<void>;
}

export interface DomainSettings {
	// Without a provider, domains are listed but cannot be added or checked.
	provider?: DomainProvider;
	// The installation's own hostnames, such as flared.page and flared.link. Neither they nor
	// their subdomains can be added by a workspace.
	reservedHostnames: readonly string[];
}

export function toApiDomain(
	record: DomainRecord,
	provider: DomainProvider | undefined,
	now: number
): Domain {
	const workspace = record.tenantId !== null;
	// An unverified claim past its expiry is shown as failed until it is removed or taken.
	const expired =
		workspace &&
		record.state !== 'active' &&
		record.claimExpiresAt !== null &&
		record.claimExpiresAt <= now;
	const failure: DomainFailure | null = expired
		? 'expired'
		: record.state === 'failed'
			? record.failureCode
			: null;
	return {
		id: record.id,
		hostname: record.hostname,
		kind: workspace ? 'workspace' : 'platform',
		state: expired ? 'failed' : record.state,
		isDefault: record.isDefault,
		records: workspace && provider ? provider.records(record.hostname) : [],
		error: failure ? { code: failure, message: domainFailureMessages[failure] } : null,
		activeLinks: workspace ? record.activeLinks : null,
		createdAt: new Date(record.createdAt).toISOString(),
		activatedAt: record.activatedAt === null ? null : new Date(record.activatedAt).toISOString()
	};
}

export async function listDomainPage(
	routing: D1Database,
	settings: DomainSettings,
	tenantId: string,
	now: number
): Promise<DomainPage> {
	const [records, usage] = await Promise.all([
		listDomains(routing, tenantId),
		domainUsage(routing, tenantId)
	]);
	if (!usage) throw new ApiError('SERVICE_UNAVAILABLE', 'Your workspace is not available.');
	return {
		domains: records.map((record) => toApiDomain(record, settings.provider, now)),
		...usage
	};
}

export async function getDomain(
	routing: D1Database,
	settings: DomainSettings,
	tenantId: string,
	domainId: string,
	now: number
): Promise<Domain> {
	const record = await findDomain(routing, tenantId, domainId);
	if (!record) throw new ApiError('NOT_FOUND', 'Domain not found.');
	return toApiDomain(record, settings.provider, now);
}

function providerOf(settings: DomainSettings): DomainProvider {
	if (!settings.provider)
		throw new ApiError(
			'DOMAINS_UNAVAILABLE',
			'Custom domains are not set up on this installation.'
		);
	return settings.provider;
}

function claimOf(record: DomainRecord): ProviderDomain {
	if (record.claimedAt === null) throw new Error('A workspace domain has no claim time');
	return { id: record.id, hostname: record.hostname, claimedAt: record.claimedAt };
}

// Runs the provider call and stores its evidence. A provider fault is stored as a failure the
// person can retry with a check.
async function settle(
	routing: D1Database,
	domain: ProviderDomain,
	call: () => Promise<DomainEvidence>,
	now: number
): Promise<void> {
	let evidence: DomainEvidence;
	try {
		evidence = await call();
	} catch {
		console.error(JSON.stringify({ event: 'domain_provider_failed', domainId: domain.id }));
		evidence = { status: 'failed', code: 'provider_error' };
	}
	await applyDomainEvidence(routing, {
		domainId: domain.id,
		claimedAt: domain.claimedAt,
		evidence,
		now
	});
}

export async function addDomain(
	routing: D1Database,
	settings: DomainSettings,
	request: { tenantId: string; hostname: string; now: number; newId?: () => string }
): Promise<{ created: boolean; domain: Domain }> {
	const { tenantId, hostname, now } = request;
	const provider = providerOf(settings);
	if (isWithinHostnames(hostname, settings.reservedHostnames))
		throw new ApiError('DOMAIN_TAKEN', 'This hostname belongs to the installation.');
	const result = await claimDomain(routing, {
		tenantId,
		hostname,
		newId: (request.newId ?? (() => crypto.randomUUID()))(),
		now,
		expiresAt: now + domainClaimLifetimeMs
	});
	if (result.outcome === 'taken')
		throw new ApiError('DOMAIN_TAKEN', 'Another workspace already uses this hostname.');
	if (result.outcome === 'limit_reached')
		throw new ApiError(
			'DOMAIN_LIMIT_REACHED',
			'Your workspace has reached its domain limit. Remove a domain first.'
		);
	if (result.outcome === 'unavailable')
		throw new ApiError('SERVICE_UNAVAILABLE', 'Your workspace is not available.');
	if (result.outcome === 'existing')
		return { created: false, domain: toApiDomain(result.domain, provider, now) };
	const claim = claimOf(result.domain);
	await settle(routing, claim, () => provider.start(claim), now);
	return { created: true, domain: await getDomain(routing, settings, tenantId, claim.id, now) };
}

export async function checkDomain(
	routing: D1Database,
	settings: DomainSettings,
	request: { tenantId: string; domainId: string; now: number }
): Promise<Domain> {
	const { tenantId, domainId, now } = request;
	const provider = providerOf(settings);
	const record = await findDomain(routing, tenantId, domainId);
	if (!record || record.tenantId === null) throw new ApiError('NOT_FOUND', 'Domain not found.');
	if (!(await markDomainChecked(routing, tenantId, domainId, now, domainCheckIntervalMs)))
		throw new ApiError(
			'DOMAIN_CHECK_TOO_SOON',
			'This domain was checked a moment ago. Try again in a minute.',
			Math.max(1, Math.ceil(((record.checkedAt ?? now) + domainCheckIntervalMs - now) / 1000))
		);
	const claim = claimOf(record);
	await settle(routing, claim, () => provider.check(claim), now);
	return getDomain(routing, settings, tenantId, domainId, now);
}

// Stops the domain's links first, then detaches it. A failed detach is logged; the
// provider's own cleanup must cover it.
export async function removeDomain(
	routing: D1Database,
	settings: DomainSettings,
	request: { tenantId: string; domainId: string; now: number }
): Promise<void> {
	const { tenantId, domainId, now } = request;
	const record = await findDomain(routing, tenantId, domainId);
	if (!record || record.tenantId === null) throw new ApiError('NOT_FOUND', 'Domain not found.');
	if (!(await disableDomain(routing, tenantId, domainId, now)))
		throw new ApiError('NOT_FOUND', 'Domain not found.');
	if (!settings.provider) return;
	try {
		await settings.provider.stop(claimOf(record));
	} catch {
		console.error(JSON.stringify({ event: 'domain_detach_failed', domainId }));
	}
}

// For an edition's scheduled reconciliation: stores evidence for one claim.
export async function recordDomainEvidence(
	routing: D1Database,
	domain: ProviderDomain,
	evidence: DomainEvidence,
	now: number
): Promise<void> {
	await applyDomainEvidence(routing, {
		domainId: domain.id,
		claimedAt: domain.claimedAt,
		evidence,
		now
	});
}
