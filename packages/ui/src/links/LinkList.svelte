<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import { untrack, type Snippet } from 'svelte';
	import EmptyState from '../empty/EmptyState.svelte';
	import Glyph from '../icons/Glyph.svelte';
	import SiteIcon from '../icons/SiteIcon.svelte';
	import Checkbox from '../atoms/Checkbox.svelte';
	import Badge from '../atoms/Badge.svelte';
	import Menu, { type MenuItem } from '../molecules/Menu.svelte';
	import Sparkline from '../molecules/Sparkline.svelte';
	import { iconHostnameOfUrl } from '@flared/contracts/icons';
	import type { Link, ListedLink } from '@flared/contracts/links';
	import { blockLabel } from './messages';

	interface Props {
		links: ListedLink[];
		// Address of a link's analytics page. Without it, the list shows no analytics link.
		analyticsHref?: (link: Link) => string;
		// Address of a link's edit form. Without it, the row menu shows no Edit item.
		editHref?: (link: Link) => string;
		// URL of the next page, or null on the last page.
		nextHref?: string | null;
		highlightId?: string | null;
		// Address of a site's icon on the app's origin. Without it, rows show a letter tile.
		iconHref?: (hostname: string) => string;
		// The list shows the result of a search or a domain filter, so no links means no match.
		filtered?: boolean;
		// What an unfiltered empty list shows in place of the default text.
		empty?: Snippet;
		// With a details panel: the open link, and the call that opens one from 48rem. Phones and
		// lists without it open the link's analytics page.
		selectedId?: string | null;
		onselect?: (link: ListedLink) => void;
		// Rows get checkboxes for an action on several links. selectedIds holds the chosen link
		// IDs on this page; bulkBar shows above the list while one link or more is chosen.
		selectable?: boolean;
		selectedIds?: string[];
		bulkBar?: Snippet<[string[]]>;
	}

	let {
		links,
		analyticsHref,
		editHref,
		nextHref = null,
		highlightId = null,
		iconHref,
		filtered = false,
		empty,
		selectedId = null,
		onselect,
		selectable = false,
		selectedIds = $bindable([]),
		bulkBar
	}: Props = $props();

	// A new page of links keeps only the chosen links it still shows.
	$effect(() => {
		const shown = new Set(links.map((link) => link.id));
		const kept = untrack(() => selectedIds).filter((id) => shown.has(id));
		if (kept.length !== untrack(() => selectedIds).length) selectedIds = kept;
	});
	const allSelected = $derived(
		links.length > 0 && links.every((link) => selectedIds.includes(link.id))
	);

	function choose(id: string, checked: boolean) {
		selectedIds = links
			.map((link) => link.id)
			.filter((item) => (item === id ? checked : selectedIds.includes(item)));
	}

	function chooseAll(checked: boolean) {
		selectedIds = checked ? links.map((link) => link.id) : [];
	}

	let status = $state('');
	const numbers = new Intl.NumberFormat();

	function clicksText(link: ListedLink): string {
		if (link.clicksLast30Days === null) return 'Clicks unavailable';
		return `${numbers.format(link.clicksLast30Days)} ${link.clicksLast30Days === 1 ? 'click' : 'clicks'} in the last 30 days`;
	}

	function display(url: string): string {
		return url.replace(/^https?:\/\//, '');
	}

	async function copy(link: Link) {
		try {
			await navigator.clipboard.writeText(link.shortUrl);
			status = `Copied ${display(link.shortUrl)}`;
		} catch {
			status = 'Copy failed. Open the link and copy it from there.';
		}
	}

	function actions(link: ListedLink): MenuItem[] {
		return [
			...(onselect
				? [{ label: 'Show details', icon: 'info' as const, onselect: () => onselect(link) }]
				: []),
			...(editHref && !link.blocked
				? [{ label: 'Edit link', icon: 'pencil' as const, href: editHref(link) }]
				: []),
			...(analyticsHref
				? [{ label: 'View analytics', icon: 'chart' as const, href: analyticsHref(link) }]
				: []),
			{ label: 'Copy link', icon: 'copy', onselect: () => void copy(link) },
			{ label: 'Open short link', icon: 'arrowUpRight', href: link.shortUrl, external: true },
			{ label: 'Open destination', icon: 'external', href: link.destination, external: true }
		];
	}

	// From 48rem a click anywhere on a row opens its details, except on the row's own controls.
	function rowClick(event: MouseEvent, link: ListedLink) {
		if (!onselect || !window.matchMedia('(min-width: 48rem)').matches) return;
		if ((event.target as HTMLElement).closest('a, button, input, label, [popover]')) return;
		onselect(link);
	}
</script>

{#snippet short(link: ListedLink)}<span class="host">{link.hostname}/</span>{link.slug}{/snippet}

<section class="link-list" aria-labelledby="link-list-heading">
	<h2 id="link-list-heading" class="visually-hidden">Your links</h2>
	<p class="visually-hidden" role="status" aria-live="polite">{status}</p>
	{#if links.length === 0}
		{#if filtered}
			<p class="empty">No links match. <a href="?">Show all links</a></p>
		{:else if empty}
			{@render empty()}
		{:else}
			<EmptyState title="No links yet"
				>Create your first short link using the field above.</EmptyState
			>
		{/if}
	{:else}
		{#if selectable}
			<div class="selection">
				<Checkbox checked={allSelected} onchange={(event) => chooseAll(event.currentTarget.checked)}
					>Select all on this page</Checkbox
				>
				{#if selectedIds.length > 0}
					<span class="chosen-count">{numbers.format(selectedIds.length)} selected</span>
					{#if bulkBar}<div class="bulk">{@render bulkBar(selectedIds)}</div>{/if}
				{/if}
			</div>
		{/if}
		<ul class="rows">
			{#each links as link (link.id)}
				{@const site = iconHostnameOfUrl(link.destination)}
				{@const name = link.title ?? display(link.shortUrl)}
				<!-- The open button is the keyboard path; the row click is a larger target. -->
				<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
				<li
					class:selectable
					class:chosen={selectable && selectedIds.includes(link.id)}
					class:selected={link.id === selectedId || link.id === highlightId}
					class:clickable={onselect}
					onclick={(event) => rowClick(event, link)}
				>
					{#if selectable}
						<span class="select-cell">
							<Checkbox
								checked={selectedIds.includes(link.id)}
								onchange={(event) => choose(link.id, event.currentTarget.checked)}
								><span class="visually-hidden">Select {name}</span></Checkbox
							>
						</span>
					{/if}
					<SiteIcon
						hostname={site ?? display(link.destination)}
						src={site && iconHref ? iconHref(site) : null}
						size={32}
					/>
					<div class="main">
						<span class="line">
							<!-- A phone opens the link's own screen; from 48rem the button opens the details. -->
							{#if analyticsHref}
								<a class="open" class:phone-only={onselect} href={analyticsHref(link)}
									>{@render short(link)}</a
								>
							{:else if !onselect}
								<span class="open">{@render short(link)}</span>
							{/if}
							{#if onselect}
								<button
									type="button"
									class="open"
									class:wide-only={analyticsHref}
									aria-expanded={link.id === selectedId}
									aria-controls="link-details"
									onclick={() => onselect(link)}>{@render short(link)}</button
								>
							{/if}
						</span>
						<!-- After the short link from 48rem; on a phone at the start of the second line, so a
						     narrow row keeps the slug. -->
						{#if link.blocked || !link.enabled}
							<span class="badges"
								>{#if link.blocked}<Badge tone="danger">{blockLabel(link.blocked.reason)}</Badge
									>{:else}<Badge>Disabled</Badge>{/if}</span
							>
						{/if}
						<span class="second" title={link.title ? undefined : link.destination}
							>{link.title ?? display(link.destination)}</span
						>
					</div>
					<span class="count">
						<span class="number" aria-hidden="true"
							>{link.clicksLast30Days === null ? '–' : numbers.format(link.clicksLast30Days)}</span
						>
						<span class="visually-hidden">{clicksText(link)}</span>
						<span class="spark"
							>{#if link.dailyClicksLast30Days}<Sparkline
									values={link.dailyClicksLast30Days}
								/>{/if}</span
						>
					</span>
					<span class="actions">
						<Menu id="link-menu-{link.id}" label="More actions for {name}" items={actions(link)} />
					</span>
				</li>
			{/each}
		</ul>
		{#if nextHref}
			<div class="foot">
				<span>Showing {numbers.format(links.length)} links</span>
				<a class="more" href={nextHref}>Next page<Glyph name="arrow" size={16} /></a>
			</div>
		{/if}
	{/if}
</section>

<style>
	.link-list {
		display: grid;
		gap: 0.5rem;
	}
	/* Choosing several links is a task for a wider screen; a phone opens one link at a time. */
	.selection,
	.select-cell {
		display: none;
	}
	.selection {
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem 1rem;
		min-height: 2.75rem;
	}
	.chosen-count {
		color: var(--color-strong);
		font-size: 0.9375rem;
		font-weight: 600;
	}
	.bulk {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
	}
	/* Phone: rows run to the screen edges with a soft line between them, as in a native list. */
	.rows {
		margin: 0 calc(var(--page-bleed, 0px) * -1);
		padding: 0;
		list-style: none;
	}
	li {
		--site-icon-size: 36px;
		position: relative;
		display: flex;
		align-items: center;
		gap: 0.75rem;
		min-height: 4.25rem;
		padding: 0.625rem calc(var(--page-bleed, 0px) - 0.5rem) 0.625rem var(--page-bleed, 0px);
	}
	li + li::before {
		content: '';
		position: absolute;
		top: 0;
		right: 0;
		left: calc(var(--page-bleed, 0px) + 3rem);
		border-top: 1px solid var(--color-rule-soft);
	}
	li:active {
		background: var(--color-surface-2);
	}
	li.chosen {
		background: var(--color-selected);
	}
	.select-cell {
		position: relative;
		z-index: 1;
		align-items: center;
	}
	.main {
		display: grid;
		flex: 1;
		grid-template-columns: auto minmax(0, 1fr);
		align-items: center;
		gap: 0.125rem 0;
		min-width: 0;
	}
	.line {
		grid-column: 1 / -1;
	}
	.badges {
		display: flex;
		grid-row: 2;
		margin-right: 0.375rem;
	}
	.second {
		grid-row: 2;
		grid-column: 2;
	}
	.line {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
	}
	.open {
		overflow: hidden;
		padding: 0;
		border: 0;
		background: none;
		color: var(--color-strong);
		font: inherit;
		font-size: 1rem;
		font-weight: 600;
		text-align: left;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	button.open {
		cursor: pointer;
	}
	/* The phone's open link covers the whole row; the checkbox and the menu sit above it. */
	a.open::after {
		content: '';
		position: absolute;
		inset: 0;
	}
	.wide-only {
		display: none;
	}
	.host {
		color: var(--color-subtle);
		font-weight: 500;
	}
	.second {
		overflow: hidden;
		color: var(--color-subtle);
		font-size: 0.8125rem;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.count {
		display: grid;
		flex: none;
		justify-items: end;
		gap: 0.3rem;
	}
	.number {
		color: var(--color-strong);
		font-size: 0.9375rem;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}
	.spark {
		display: block;
		--sparkline-color: var(--color-faint);
		width: 2.5rem;
		height: 0.875rem;
	}
	.actions {
		position: relative;
		z-index: 1;
		flex: none;
	}
	.foot {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding-top: 0.5rem;
		color: var(--color-subtle);
		font-size: 0.875rem;
	}
	.more {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		min-height: 2.75rem;
		color: var(--color-link);
		text-decoration: underline;
		text-underline-offset: 3px;
	}
	.empty {
		padding: 2rem 0;
		color: var(--color-subtle);
		text-align: center;
	}
	.empty a {
		color: var(--color-link);
		text-decoration: underline;
		text-underline-offset: 3px;
	}
	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
	/* 48rem and up: separate rounded rows with a 30-day sparkline beside the count, and the row
	   opens the details panel. */
	@media (min-width: 48rem) {
		.rows {
			display: grid;
			margin: 0;
		}
		li {
			--site-icon-size: 32px;
			display: grid;
			grid-template-columns: 2rem minmax(0, 1fr) 5.25rem 3.5rem auto;
			min-height: 3.5rem;
			padding: 0.625rem 0.25rem 0.625rem 0.75rem;
			border-radius: 0.75rem;
			transition: background-color var(--dur-fast, 0.15s);
		}
		li.selectable {
			grid-template-columns: auto 2rem minmax(0, 1fr) 5.25rem 3.5rem auto;
		}
		.selection,
		.select-cell {
			display: flex;
		}
		li + li::before {
			display: none;
		}
		li:active {
			background: none;
		}
		.phone-only {
			display: none;
		}
		.wide-only {
			display: block;
		}
		a.open::after {
			content: none;
		}
		.open {
			font-size: 0.9375rem;
		}
		.open:hover {
			text-decoration: underline;
			text-underline-offset: 3px;
		}
		.second {
			grid-column: 1 / -1;
			font-size: 0.75rem;
		}
		.main {
			grid-template-columns: minmax(0, max-content) 1fr;
		}
		.line {
			grid-column: 1;
		}
		.badges {
			grid-row: 1;
			grid-column: 2;
			margin: 0 0 0 0.5rem;
		}
		/* The count and its sparkline become two columns. */
		.count {
			display: contents;
		}
		.spark {
			grid-column: -4;
			grid-row: 1;
			width: 100%;
			height: 1.5rem;
			--sparkline-color: var(--color-surface-3);
			--sparkline-gap: 1px;
		}
		.number {
			grid-column: -3;
			grid-row: 1;
			justify-self: end;
		}
		.clickable {
			cursor: pointer;
		}
		li.selected {
			background: var(--color-surface-2);
			box-shadow: var(--shadow-ring);
		}
		li.selected .spark {
			--sparkline-color: var(--color-faint);
		}
		li.chosen {
			background: var(--color-selected);
		}
	}
	@media (min-width: 48rem) and (hover: hover) {
		.clickable:hover {
			background: var(--color-surface-2);
		}
		.clickable:hover .spark {
			--sparkline-color: var(--color-faint);
		}
	}
</style>
