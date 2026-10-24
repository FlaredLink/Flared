// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { renderPage } from '../packages/contracts/src/page-render';
import { parseUpdatePage, type Page } from '../packages/contracts/src/pages';
import {
	changeOf,
	draftOf,
	isDirty,
	missingLinks,
	newBlock,
	previewOf
} from '../packages/ui/src/pages/draft';

const page: Page = {
	id: 'page_1',
	handle: 'ada',
	url: 'https://ada.flared.site',
	domainId: null,
	domainUrl: null,
	title: 'Ada',
	bio: null,
	avatarImage: null,
	backgroundImage: null,
	theme: { id: 'paper' },
	blocks: [
		{
			kind: 'button',
			linkId: 'link_1',
			label: 'Shop',
			shortUrl: 'https://flared.link/shop',
			startsAt: null,
			endsAt: null,
			visible: true
		},
		{ kind: 'header', label: 'More', startsAt: null, endsAt: null, visible: true },
		{
			kind: 'button',
			linkId: 'link_2',
			label: 'Off',
			shortUrl: 'https://flared.link/off',
			startsAt: null,
			endsAt: null,
			visible: false
		}
	],
	enabled: true,
	blocked: null,
	createdAt: '2026-10-25T00:00:00.000Z',
	updatedAt: '2026-10-25T00:00:00.000Z'
};

const images = { avatarUrl: null, backgroundUrl: null };
const now = Date.parse('2026-10-25T12:00:00.000Z');

describe('page draft', () => {
	it('sends nothing for an untouched page and is not dirty', () => {
		const draft = draftOf(page);
		expect(isDirty(draft, page)).toBe(false);
		expect(changeOf(draft, page)).toEqual({});
	});

	it('sends only the changed fields, and blocks as the whole list the API accepts', () => {
		const draft = draftOf(page);
		draft.title = 'Ada Lovelace';
		draft.handle = ' Ada-L ';
		draft.blocks[1] = { ...draft.blocks[1], startsAt: '2026-11-01T00:00:00.000Z' };
		expect(isDirty(draft, page)).toBe(true);
		const change = changeOf(draft, page);
		expect(change).toEqual({
			handle: 'ada-l',
			title: 'Ada Lovelace',
			blocks: [
				{ kind: 'button', linkId: 'link_1', label: 'Shop', startsAt: null, endsAt: null },
				{ kind: 'header', label: 'More', startsAt: '2026-11-01T00:00:00.000Z', endsAt: null },
				{ kind: 'button', linkId: 'link_2', label: 'Off', startsAt: null, endsAt: null }
			]
		});
		expect(() => parseUpdatePage(JSON.parse(JSON.stringify(change)))).not.toThrow();
	});

	it('clears the bio with null and sends a theme reset', () => {
		const withBio: Page = { ...page, bio: 'Hello', theme: { id: 'ink', text: '#ffffff' } };
		const draft = draftOf(withBio);
		draft.bio = '  ';
		draft.theme = { id: 'ink' };
		expect(changeOf(draft, withBio)).toEqual({ bio: null, theme: { id: 'ink' } });
	});

	it('asks for a link on a button with neither a link nor a destination', () => {
		const draft = draftOf(page);
		draft.blocks.push(newBlock('button', 'Tour dates'));
		const pasted = newBlock('button', 'Merch');
		if (pasted.kind === 'button') pasted.destination = 'https://shop.example';
		draft.blocks.push(pasted);
		expect(missingLinks(draft)).toEqual([
			{ index: 3, field: 'blocks.3.destination', message: 'Paste a destination or choose a link.' }
		]);
		expect(isDirty(draft, page)).toBe(true);
	});

	it('ignores keys, so a reordered draft is dirty and a restored one is not', () => {
		const draft = draftOf(page);
		draft.blocks.reverse();
		expect(isDirty(draft, page)).toBe(true);
		draft.blocks.reverse();
		expect(isDirty(draft, page)).toBe(false);
	});

	it('previews what a visitor sees now, with no player and no new window', () => {
		const draft = draftOf(page);
		draft.blocks.push({ ...newBlock('header', 'Later'), startsAt: '2026-12-01T00:00:00.000Z' });
		const embed = newBlock('embed');
		if (embed.kind === 'embed') embed.address = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
		const broken = newBlock('embed');
		if (broken.kind === 'embed') broken.address = 'https://example.com/video';
		draft.blocks.push(embed, broken, newBlock('button', ''));
		const view = previewOf(draft, images, { url: page.url ?? '', badge: true, now });
		expect(view.preview).toBe(true);
		expect(view.blocks.map((block) => block.kind)).toEqual(['button', 'header', 'embed']);
		const { html } = renderPage(view);
		expect(html).toContain('<base target="_blank">');
		expect(html).toContain('YouTube player');
		expect(html).not.toContain('<iframe');
		expect(html).toContain('Made with Flared');
		const live = renderPage({ ...view, preview: false }).html;
		expect(live).toContain('<iframe');
		expect(live).not.toContain('<base');
	});
});
