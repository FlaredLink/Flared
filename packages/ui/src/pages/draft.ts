// SPDX-License-Identifier: AGPL-3.0-only
// The editor's copy of a page. The member changes the draft; Save turns it into one PATCH body.
// A button or a payment card can name a new destination in place of a link: Save creates that
// link first, with an idempotency key kept in the block, so a retry after a failure never makes
// a second link.
import {
	embedSource,
	type EmbedProvider,
	type Page,
	type PageBlock,
	type PageBlockBody,
	type PageBlockKind,
	type PageTheme,
	type PaymentProvider,
	type SocialNetwork,
	type UpdatePageBody
} from '@flared/contracts/pages';
import type { PageView } from '@flared/contracts/page-render';

interface Common {
	// Unique in the draft; keys the block in lists.
	key: string;
	// ISO 8601 times, or '' for no bound.
	startsAt: string;
	endsAt: string;
	// False when the page hides the block: its link is off, blocked, or left its checkout host.
	visible: boolean;
}

export interface LinkTarget {
	linkId: string | null;
	shortUrl: string | null;
	// A new destination; Save creates a link for it while linkId is null.
	destination: string;
	idempotencyKey: string;
}

export type DraftBlock = Common &
	(
		| ({ kind: 'button'; label: string } & LinkTarget)
		| { kind: 'header'; label: string }
		| { kind: 'social'; links: { network: SocialNetwork; address: string }[] }
		| ({
				kind: 'payment';
				provider: PaymentProvider;
				label: string;
				price: string;
				description: string;
		  } & LinkTarget)
		| { kind: 'embed'; provider: EmbedProvider; address: string }
		| { kind: 'signup'; label: string; buttonLabel: string }
	);

export interface PageDraft {
	handle: string;
	title: string;
	bio: string;
	theme: PageTheme;
	domainId: string | null;
	blocks: DraftBlock[];
}

export function newKey(): string {
	return crypto.randomUUID();
}

function common(block: { startsAt: string | null; endsAt: string | null; visible: boolean }) {
	return {
		key: newKey(),
		startsAt: block.startsAt ?? '',
		endsAt: block.endsAt ?? '',
		visible: block.visible
	};
}

function target(linkId: string, shortUrl: string): LinkTarget {
	return { linkId, shortUrl, destination: '', idempotencyKey: newKey() };
}

export function draftBlockOf(block: PageBlock): DraftBlock {
	switch (block.kind) {
		case 'button':
			return {
				...common(block),
				kind: 'button',
				label: block.label,
				...target(block.linkId, block.shortUrl)
			};
		case 'header':
			return { ...common(block), kind: 'header', label: block.label };
		case 'social':
			return { ...common(block), kind: 'social', links: block.links.map((link) => ({ ...link })) };
		case 'payment':
			return {
				...common(block),
				kind: 'payment',
				provider: block.provider,
				label: block.label,
				price: block.price ?? '',
				description: block.description ?? '',
				...target(block.linkId, block.shortUrl)
			};
		case 'embed':
			return { ...common(block), kind: 'embed', provider: block.provider, address: block.address };
		case 'signup':
			return {
				...common(block),
				kind: 'signup',
				label: block.label,
				buttonLabel: block.buttonLabel
			};
	}
}

export function draftOf(page: Page): PageDraft {
	return {
		handle: page.handle,
		title: page.title,
		bio: page.bio ?? '',
		theme: { ...page.theme },
		domainId: page.domainId,
		blocks: page.blocks.map(draftBlockOf)
	};
}

const blank = { startsAt: '', endsAt: '', visible: true };
const noTarget = (): LinkTarget => ({
	linkId: null,
	shortUrl: null,
	destination: '',
	idempotencyKey: newKey()
});

export function newBlock(kind: PageBlockKind, label = ''): DraftBlock {
	const key = newKey();
	switch (kind) {
		case 'button':
			return { key, ...blank, kind, label, ...noTarget() };
		case 'header':
			return { key, ...blank, kind, label };
		case 'social':
			return { key, ...blank, kind, links: [{ network: 'instagram', address: '' }] };
		case 'payment':
			return {
				key,
				...blank,
				kind,
				provider: 'stripe',
				label,
				price: '',
				description: '',
				...noTarget()
			};
		case 'embed':
			return { key, ...blank, kind, provider: 'youtube', address: '' };
		case 'signup':
			return { key, ...blank, kind, label, buttonLabel: 'Sign up' };
	}
}

export type LinkedBlock = Extract<DraftBlock, { kind: 'button' | 'payment' }>;

export function isLinked(block: DraftBlock): block is LinkedBlock {
	return block.kind === 'button' || block.kind === 'payment';
}

// A block that Save cannot send yet, with the field to mark.
export interface DraftProblem {
	index: number;
	field: string;
	message: string;
}

// Buttons and cards that still need a link: the ones with a destination get one at Save, the
// others are a problem to fix first.
export function missingLinks(draft: PageDraft): DraftProblem[] {
	return draft.blocks.flatMap((block, index) =>
		isLinked(block) && block.linkId === null && !block.destination.trim()
			? [
					{
						index,
						field: `blocks.${index}.destination`,
						message: 'Paste a destination or choose a link.'
					}
				]
			: []
	);
}

function blockBody(block: DraftBlock): PageBlockBody {
	const schedule = { startsAt: block.startsAt || null, endsAt: block.endsAt || null };
	const linkId = (value: LinkTarget) => {
		// missingLinks and the link creation run first, so every linked block has its ID here.
		if (value.linkId === null) throw new Error('A linked block has no link yet.');
		return value.linkId;
	};
	switch (block.kind) {
		case 'button':
			return { kind: 'button', linkId: linkId(block), label: block.label, ...schedule };
		case 'header':
			return { kind: 'header', label: block.label, ...schedule };
		case 'social':
			return { kind: 'social', links: block.links.map((link) => ({ ...link })), ...schedule };
		case 'payment':
			return {
				kind: 'payment',
				linkId: linkId(block),
				provider: block.provider,
				label: block.label,
				price: block.price.trim() || null,
				description: block.description.trim() || null,
				...schedule
			};
		case 'embed':
			return { kind: 'embed', provider: block.provider, address: block.address, ...schedule };
		case 'signup':
			return {
				kind: 'signup',
				label: block.label,
				buttonLabel: block.buttonLabel,
				...schedule
			};
	}
}

// The PATCH body: only the fields that differ from the saved page. blocks always goes as a whole
// list, as the API replaces it.
export function changeOf(draft: PageDraft, page: Page): UpdatePageBody {
	const change: UpdatePageBody = {};
	const handle = draft.handle.trim().toLowerCase();
	if (handle !== page.handle) change.handle = handle;
	if (draft.title !== page.title) change.title = draft.title;
	const bio = draft.bio.trim() ? draft.bio : null;
	if (bio !== page.bio) change.bio = bio;
	if (JSON.stringify(draft.theme) !== JSON.stringify(page.theme)) change.theme = draft.theme;
	if (draft.domainId !== page.domainId) change.domainId = draft.domainId;
	const blocks = draft.blocks.map(blockBody);
	const saved = draftOf(page).blocks.map(blockBody);
	if (JSON.stringify(blocks) !== JSON.stringify(saved)) change.blocks = blocks;
	return change;
}

// Keys, idempotency keys, and the saved visibility are not content.
const notContent = new Set(['key', 'idempotencyKey', 'visible']);

// Whether the draft has changes that Save would send.
export function isDirty(draft: PageDraft, page: Page): boolean {
	const text = (value: PageDraft) =>
		JSON.stringify({ ...value, handle: value.handle.trim().toLowerCase() }, (name, item) =>
			notContent.has(name) ? undefined : item
		);
	return text(draft) !== text(draftOf(page));
}

function inSchedule(block: DraftBlock, now: number): boolean {
	const starts = block.startsAt ? Date.parse(block.startsAt) : Number.NaN;
	const ends = block.endsAt ? Date.parse(block.endsAt) : Number.NaN;
	return !(starts > now) && !(ends <= now);
}

// Whether a visitor sees the block now. The draft's own blocks show until Save says otherwise.
export function shownNow(block: DraftBlock, now: number): boolean {
	return block.visible && inSchedule(block, now);
}

function previewBlock(block: DraftBlock): PageBlock | null {
	const times = { startsAt: block.startsAt || null, endsAt: block.endsAt || null, visible: true };
	// A new destination has no short URL yet; the preview's links open nothing anyway.
	const shortUrl = (value: LinkTarget) => value.shortUrl ?? '#';
	switch (block.kind) {
		case 'button':
			return block.label.trim()
				? {
						kind: 'button',
						linkId: block.linkId ?? '',
						label: block.label,
						shortUrl: shortUrl(block),
						...times
					}
				: null;
		case 'header':
			return block.label.trim() ? { kind: 'header', label: block.label, ...times } : null;
		case 'social': {
			const links = block.links.filter((link) => link.address.trim());
			return links.length > 0 ? { kind: 'social', links, ...times } : null;
		}
		case 'payment':
			return block.label.trim()
				? {
						kind: 'payment',
						linkId: block.linkId ?? '',
						provider: block.provider,
						label: block.label,
						price: block.price.trim() || null,
						description: block.description.trim() || null,
						shortUrl: shortUrl(block),
						...times
					}
				: null;
		case 'embed':
			return embedSource(block.provider, block.address.trim()) === null
				? null
				: { kind: 'embed', provider: block.provider, address: block.address.trim(), ...times };
		case 'signup':
			return null;
	}
}

// What the preview draws: the draft as a visitor would see it now.
export function previewOf(
	draft: PageDraft,
	images: { avatarUrl: string | null; backgroundUrl: string | null },
	options: { url: string; badge: boolean; now: number }
): PageView {
	return {
		title: draft.title.trim() || 'Untitled page',
		bio: draft.bio.trim() || null,
		theme: draft.theme,
		url: options.url,
		...images,
		blocks: draft.blocks.flatMap((block) => {
			if (!shownNow(block, options.now)) return [];
			const shown = previewBlock(block);
			return shown ? [shown] : [];
		}),
		badge: options.badge,
		preview: true
	};
}
