// SPDX-License-Identifier: AGPL-3.0-only
// Page product rules on top of the routing store: button links, page extras, handles, and the
// API form of a page.
import type { D1Database } from '@cloudflare/workers-types/index.ts';
import {
	PageInputError,
	extraBlockKinds,
	maxPageHandles,
	isPaymentDestination,
	pageImagePath,
	usesPageExtras,
	type CreatePageInput,
	type EmbedProvider,
	type Page,
	type PageBlock,
	type PageBlockInput,
	type PageList,
	type PageSummary,
	type PaymentProvider,
	type SocialLink,
	type UpdatePageInput
} from '@flared/contracts/pages';
import {
	createPage as createPageRecord,
	deletePage,
	listPages as listPageRows,
	readPage,
	readPageBlocks,
	readPageLinks,
	readPageRefusal,
	storedBlock,
	updatePage,
	type PageBlockRow,
	type PageLink,
	type PageRow
} from '@flared/data/pages';
import { ApiError } from './links';

// The host that serves pages at <handle>.<host>, such as flared.site. Without it, a page shows
// only at the root of a workspace domain.
export interface PageSettings {
	host?: string;
	// The installation's URL reputation check: it gets the destinations of the links that a page
	// change adds to buttons and cards, and returns those listed as harmful, which refuse the
	// change. A check that throws lets the change through; the installation checks again later.
	checkDestinations?: (destinations: readonly string[]) => Promise<readonly string[]>;
}

const iso = (value: number | null) => (value === null ? null : new Date(value).toISOString());

function pageUrl(row: PageRow, settings: PageSettings): string | null {
	return settings.host ? `https://${row.handle}.${settings.host}` : null;
}

function summaryOf(row: PageRow, settings: PageSettings): PageSummary {
	return {
		id: row.id,
		handle: row.handle,
		url: pageUrl(row, settings),
		domainUrl: row.domainHostname ? `https://${row.domainHostname}` : null,
		title: row.title,
		enabled: row.active,
		blocked: row.blockedReason ? { reason: row.blockedReason } : null,
		createdAt: new Date(row.createdAt).toISOString(),
		updatedAt: new Date(row.updatedAt).toISOString()
	};
}

function stringField(data: Record<string, unknown> | null, field: string): string | null {
	const value = data?.[field];
	return typeof value === 'string' ? value : null;
}

// The read form of a stored block. A button or a card is visible while its link opens; a card
// also needs its link to open the provider's checkout.
export function blockOf(row: PageBlockRow): PageBlock {
	const schedule = { startsAt: iso(row.startsAt), endsAt: iso(row.endsAt) };
	const linkOpen = row.link?.open === true;
	const label = row.label ?? '';
	switch (row.kind) {
		case 'button':
			return {
				kind: 'button',
				linkId: row.linkId ?? '',
				label,
				shortUrl: row.link?.shortUrl ?? '',
				...schedule,
				visible: linkOpen
			};
		case 'header':
			return { kind: 'header', label, ...schedule, visible: true };
		case 'social': {
			const links = Array.isArray(row.data?.links) ? (row.data.links as SocialLink[]) : [];
			return { kind: 'social', links, ...schedule, visible: links.length > 0 };
		}
		case 'payment': {
			const provider = stringField(row.data, 'provider') as PaymentProvider;
			return {
				kind: 'payment',
				linkId: row.linkId ?? '',
				provider,
				label,
				price: stringField(row.data, 'price'),
				description: stringField(row.data, 'description'),
				shortUrl: row.link?.shortUrl ?? '',
				...schedule,
				visible:
					linkOpen && row.link !== null && isPaymentDestination(provider, row.link.destination)
			};
		}
		case 'embed':
			return {
				kind: 'embed',
				provider: stringField(row.data, 'provider') as EmbedProvider,
				address: stringField(row.data, 'address') ?? '',
				...schedule,
				visible: true
			};
		case 'signup':
			return {
				kind: 'signup',
				label,
				buttonLabel: stringField(row.data, 'buttonLabel') ?? '',
				...schedule,
				visible: true
			};
	}
}

// An image's address on the page host, or else on the workspace domain; null when the page has
// neither.
function imageUrl(row: PageRow, settings: PageSettings, file: string | null): string | null {
	const base =
		pageUrl(row, settings) ?? (row.domainHostname ? `https://${row.domainHostname}` : null);
	return file === null || base === null ? null : `${base}${pageImagePath(file)}`;
}

export function toApiPage(row: PageRow, blocks: PageBlockRow[], settings: PageSettings): Page {
	return {
		...summaryOf(row, settings),
		domainId: row.domainId,
		bio: row.bio,
		avatarImage: imageUrl(row, settings, row.avatarImage),
		backgroundImage: imageUrl(row, settings, row.backgroundImage),
		theme: row.theme,
		blocks: blocks.map(blockOf)
	};
}

export const pageExtrasMessage =
	'Your plan does not include payment, embed, or sign-up blocks, or a page on your own domain.';

const destinationsOf = (link: PageLink) =>
	[link.destination, link.iosDestination, link.androidDestination].filter(
		(destination): destination is string => destination !== null
	);

// The installation's check of the links that the change adds; a link the page already opens was
// checked when it was added.
async function checkAddedDestinations(
	settings: PageSettings,
	blocks: readonly PageBlockInput[],
	links: ReadonlyMap<string, PageLink>,
	kept: ReadonlySet<string>
): Promise<void> {
	const check = settings.checkDestinations;
	if (!check) return;
	const added = [...links.values()].filter((link) => !kept.has(link.id));
	const destinations = [...new Set(added.flatMap(destinationsOf))];
	if (destinations.length === 0) return;
	let unsafe: ReadonlySet<string>;
	try {
		unsafe = new Set(await check(destinations));
	} catch {
		console.error(JSON.stringify({ event: 'page_destination_check_failed' }));
		return;
	}
	if (unsafe.size === 0) return;
	const block = blocks.find((item) => {
		if (item.kind !== 'button' && item.kind !== 'payment') return false;
		const link = links.get(item.linkId);
		return (
			link !== undefined && !kept.has(link.id) && destinationsOf(link).some((d) => unsafe.has(d))
		);
	});
	throw new ApiError(
		'PAGE_DESTINATION_UNSAFE',
		block && 'label' in block && block.label
			? `The link of "${block.label}" leads to a site that is listed as harmful. Use another link.`
			: 'A link leads to a site that is listed as harmful. Use another link.'
	);
}

// Every button and card names a link of the workspace; a card's link opens its provider's
// checkout. kept: the links that the page opens already.
async function checkBlockLinks(
	routing: D1Database,
	tenantId: string,
	blocks: readonly PageBlockInput[],
	settings: PageSettings,
	kept: ReadonlySet<string> = new Set()
): Promise<void> {
	const ids = blocks.flatMap((block) =>
		block.kind === 'button' || block.kind === 'payment' ? [block.linkId] : []
	);
	const links = new Map(
		(await readPageLinks(routing, tenantId, ids)).map((link) => [link.id, link])
	);
	blocks.forEach((block, index) => {
		if (block.kind !== 'button' && block.kind !== 'payment') return;
		const link = links.get(block.linkId);
		if (link === undefined)
			throw new PageInputError(`blocks.${index}.linkId`, 'Use a link of this workspace.');
		if (block.kind === 'payment' && !isPaymentDestination(block.provider, link.destination))
			throw new PageInputError(
				`blocks.${index}.linkId`,
				'Use a link that opens the checkout page of this payment provider.'
			);
	});
	await checkAddedDestinations(settings, blocks, links, kept);
}

// Turns a refused write into the error that explains it. The write decided under its own
// conditions, so a refusal that this read cannot explain is a conflict to retry.
async function refusal(
	routing: D1Database,
	tenantId: string,
	pageId: string | null,
	handle: string | null,
	domainId: string | null,
	needsExtras: boolean
): Promise<ApiError> {
	const reason = await readPageRefusal(routing, tenantId, handle, domainId);
	if (!reason.policy)
		return new ApiError('SERVICE_UNAVAILABLE', 'Your workspace is not ready. Try again.');
	if (handle !== null) {
		if (reason.handleReserved)
			return new ApiError('HANDLE_TAKEN', 'This page address is reserved.');
		if (
			reason.handle &&
			(reason.handle.tenantId !== tenantId ||
				(reason.handle.held && reason.handle.pageId !== pageId))
		)
			return new ApiError('HANDLE_TAKEN', 'This page address is taken.');
		if (!reason.handle && reason.handles >= maxPageHandles)
			return new ApiError(
				'PAGE_LIMIT_REACHED',
				`Your workspace has used its ${maxPageHandles} page addresses. Use one it had before.`
			);
	}
	if (needsExtras && !reason.policy.pageExtras)
		return new ApiError('PAGE_EXTRAS_REQUIRES_PLAN', pageExtrasMessage);
	if (domainId !== null && !reason.domainOwned)
		return new ApiError('DOMAIN_UNAVAILABLE', 'Use a domain of your workspace.');
	if (pageId === null && reason.pages >= reason.policy.pageLimit)
		return new ApiError(
			'PAGE_LIMIT_REACHED',
			reason.policy.pageLimit === 0
				? 'Your plan does not include pages.'
				: 'Your workspace has reached its page limit.'
		);
	return new ApiError('SERVICE_UNAVAILABLE', 'The page changed at the same time. Try again.');
}

// The unique domain index and the link foreign key are the last guards; they show only when a
// request races another.
function constraintError(error: unknown): ApiError | null {
	const message = error instanceof Error ? error.message : '';
	if (message.includes('pages.domain_id'))
		return new ApiError('PAGE_DOMAIN_TAKEN', 'Another page already shows on this domain.');
	if (message.includes('FOREIGN KEY'))
		return new ApiError('INVALID_INPUT', 'Use links of this workspace.');
	return null;
}

export async function createPage(
	routing: D1Database,
	request: {
		tenantId: string;
		input: CreatePageInput;
		now: number;
		settings: PageSettings;
		newId?: () => string;
	}
): Promise<Page> {
	const { tenantId, input, now } = request;
	await checkBlockLinks(routing, tenantId, input.blocks, request.settings);
	const pageId = request.newId?.() ?? crypto.randomUUID();
	const usesExtras = usesPageExtras(input);
	let result;
	try {
		result = await createPageRecord(routing, {
			tenantId,
			pageId,
			handle: input.handle,
			title: input.title,
			bio: input.bio,
			theme: input.theme,
			blocks: input.blocks,
			domainId: input.domainId,
			usesExtras,
			now
		});
	} catch (error) {
		throw constraintError(error) ?? error;
	}
	if (result === 'refused')
		throw await refusal(routing, tenantId, null, input.handle, input.domainId, usesExtras);
	return getPage(routing, tenantId, pageId, request.settings);
}

export async function getPage(
	routing: D1Database,
	tenantId: string,
	pageId: string,
	settings: PageSettings
): Promise<Page> {
	const row = await readPage(routing, tenantId, pageId);
	if (!row) throw new ApiError('NOT_FOUND', 'Page not found.');
	return toApiPage(row, await readPageBlocks(routing, tenantId, pageId), settings);
}

function encodeCursor(row: PageRow): string {
	return `${row.createdAt}.${row.id}`;
}

function decodeCursor(value: string): { createdAt: number; id: string } {
	const match = /^(\d{1,15})\.([A-Za-z0-9-]{1,64})$/.exec(value);
	if (!match)
		throw new ApiError('INVALID_INPUT', 'Use the nextCursor value from the previous page.');
	return { createdAt: Number(match[1]), id: match[2] };
}

export async function listPages(
	routing: D1Database,
	tenantId: string,
	query: { limit: number; cursor: string | null },
	settings: PageSettings
): Promise<PageList> {
	const rows = await listPageRows(routing, tenantId, {
		limit: query.limit + 1,
		after: query.cursor ? decodeCursor(query.cursor) : null
	});
	const page = rows.slice(0, query.limit);
	const last = page.at(-1);
	return {
		pages: page.map((row) => summaryOf(row, settings)),
		nextCursor: rows.length > query.limit && last ? encodeCursor(last) : null
	};
}

const blockKey = (block: PageBlockInput) => {
	const { startsAt: _startsAt, endsAt: _endsAt, ...stored } = storedBlock(block);
	return JSON.stringify(stored);
};

// Whether the change adds something that needs page extras. An extra block the page already has,
// or the domain it already shows on, is no change, so an editor that sends the page back after a
// downgrade can still save its other fields.
function changeNeedsExtras(
	change: UpdatePageInput,
	row: PageRow,
	stored: readonly PageBlockRow[]
): boolean {
	if (change.domainId !== undefined && change.domainId !== null && change.domainId !== row.domainId)
		return true;
	if (!change.blocks || !usesPageExtras({ blocks: change.blocks })) return false;
	const kept = new Set(
		stored
			.filter((block) => extraBlockKinds.includes(block.kind))
			.map((block) =>
				JSON.stringify({
					kind: block.kind,
					linkId: block.linkId,
					label: block.label,
					data: block.data === null ? null : JSON.stringify(block.data)
				})
			)
	);
	return change.blocks
		.filter((block) => extraBlockKinds.includes(block.kind))
		.some((block) => !kept.has(blockKey(block)));
}

export async function changePage(
	routing: D1Database,
	request: {
		tenantId: string;
		pageId: string;
		change: UpdatePageInput;
		now: number;
		settings: PageSettings;
	}
): Promise<Page> {
	const { tenantId, pageId, change, now } = request;
	const row = await readPage(routing, tenantId, pageId);
	if (!row) throw new ApiError('NOT_FOUND', 'Page not found.');
	if (row.blockedReason) throw new ApiError('PAGE_BLOCKED', 'Flared blocked this page for abuse.');
	const stored = await readPageBlocks(routing, tenantId, pageId);
	if (change.blocks)
		await checkBlockLinks(
			routing,
			tenantId,
			change.blocks,
			request.settings,
			new Set(stored.flatMap((block) => (block.linkId === null ? [] : [block.linkId])))
		);
	const needsExtras = changeNeedsExtras(change, row, stored);
	const handle =
		change.handle !== undefined && change.handle !== row.handle ? change.handle : undefined;
	let result;
	try {
		result = await updatePage(routing, tenantId, pageId, {
			handle,
			title: change.title,
			bio: change.bio,
			theme: change.theme,
			blocks: change.blocks,
			domainId: change.domainId,
			active: change.enabled,
			needsExtras,
			now
		});
	} catch (error) {
		throw constraintError(error) ?? error;
	}
	if (!result.updated) {
		const current = await readPage(routing, tenantId, pageId);
		if (!current) throw new ApiError('NOT_FOUND', 'Page not found.');
		if (current.blockedReason)
			throw new ApiError('PAGE_BLOCKED', 'Flared blocked this page for abuse.');
		throw await refusal(
			routing,
			tenantId,
			pageId,
			handle ?? null,
			change.domainId ?? null,
			needsExtras
		);
	}
	return getPage(routing, tenantId, pageId, request.settings);
}

export async function removePage(
	routing: D1Database,
	tenantId: string,
	pageId: string,
	now: number
): Promise<void> {
	if (await deletePage(routing, tenantId, pageId, now)) return;
	const row = await readPage(routing, tenantId, pageId);
	if (!row) throw new ApiError('NOT_FOUND', 'Page not found.');
	throw new ApiError('PAGE_BLOCKED', 'Flared blocked this page for abuse.');
}
