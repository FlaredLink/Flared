// SPDX-License-Identifier: AGPL-3.0-only
// Starter pages: a theme and sample blocks. The sample buttons have labels and no link yet; the
// member pastes a destination for each, or removes it, before the first save. Every plan has
// every template.
import type { PageBlockKind } from '@flared/contracts/pages';

export interface PageTemplate {
	id: string;
	name: string;
	description: string;
	theme: string;
	blocks: { kind: Extract<PageBlockKind, 'button' | 'header'>; label: string }[];
}

const button = (label: string) => ({ kind: 'button' as const, label });
const header = (label: string) => ({ kind: 'header' as const, label });

export const pageTemplates: readonly PageTemplate[] = [
	{
		id: 'blank',
		name: 'Blank',
		description: 'Start with an empty page.',
		theme: 'paper',
		blocks: []
	},
	{
		id: 'creator',
		name: 'Creator',
		description: 'Videos, a newsletter, and your picks.',
		theme: 'ember',
		blocks: [button('Latest video'), button('Newsletter'), header('Shop'), button('My picks')]
	},
	{
		id: 'musician',
		name: 'Musician',
		description: 'New music, tour dates, and merch.',
		theme: 'grape',
		blocks: [button('Listen now'), button('Tour dates'), button('Merch')]
	},
	{
		id: 'shop',
		name: 'Shop',
		description: 'Products, new arrivals, and contact.',
		theme: 'sun',
		blocks: [button('Shop now'), button('New arrivals'), header('Questions?'), button('Contact us')]
	},
	{
		id: 'developer',
		name: 'Developer',
		description: 'Code, writing, and projects.',
		theme: 'terminal',
		blocks: [button('GitHub'), button('Blog'), button('Projects')]
	},
	{
		id: 'business',
		name: 'Business',
		description: 'Services, booking, and contact.',
		theme: 'slate',
		blocks: [button('Book a call'), button('Services'), button('Contact')]
	},
	{
		id: 'event',
		name: 'Event',
		description: 'Tickets, schedule, and venue.',
		theme: 'rose',
		blocks: [button('Get tickets'), button('Schedule'), button('Venue and travel')]
	}
];

export function pageTemplate(id: string | null | undefined): PageTemplate | undefined {
	return pageTemplates.find((template) => template.id === id);
}
