<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import EmptyState from '../empty/EmptyState.svelte';
	import Glyph from '../icons/Glyph.svelte';
	import SiteIcon from '../icons/SiteIcon.svelte';
	import IconButton from '../atoms/IconButton.svelte';
	import Badge from '../atoms/Badge.svelte';
	import Menu, { type MenuItem } from '../molecules/Menu.svelte';
	import { iconHostnameOfUrl } from '@flared/contracts/icons';
	import type { Link, ListedLink } from '@flared/contracts/links';
	import { blockLabel } from './messages';

	interface Props {
		links: ListedLink[];
		// Address of a link's analytics page. Without it, the list shows no analytics link.
		analyticsHref?: (link: Link) => string;
		// URL of the next page, or null on the last page.
		nextHref?: string | null;
		highlightId?: string | null;
		// Address of a site's icon on the app's origin. Without it, rows show a letter tile.
		iconHref?: (hostname: string) => string;
		// Search and domain filter above the table. They submit as ?q= and ?domain= to this page,
		// which passes them to GET /v1/links. Without it, the list shows no filters.
		filters?: { search: string; domainId: string; domains: { id: string; hostname: string }[] };
		// With a details panel: the open link, and the call that opens one. Without it, a title
		// opens the analytics page.
		selectedId?: string | null;
		onselect?: (link: ListedLink) => void;
		// The search field, for a shortcut that focuses it.
		searchInput?: HTMLInputElement;
	}

	let {
		links,
		analyticsHref,
		nextHref = null,
		highlightId = null,
		iconHref,
		filters,
		selectedId = null,
		onselect,
		searchInput = $bindable()
	}: Props = $props();
	const filtered = $derived(Boolean(filters && (filters.search || filters.domainId)));
	let status = $state('');
	let copiedId = $state<string | null>(null);
	let copiedTimer: ReturnType<typeof setTimeout> | undefined;

	const numbers = new Intl.NumberFormat();

	function clicksText(link: ListedLink): string {
		if (link.clicksLast30Days === null) return 'Clicks unavailable';
		return `${numbers.format(link.clicksLast30Days)} ${link.clicksLast30Days === 1 ? 'click' : 'clicks'}`;
	}

	function clicksNumber(link: ListedLink): string {
		return link.clicksLast30Days === null ? '–' : numbers.format(link.clicksLast30Days);
	}

	function display(url: string): string {
		return url.replace(/^https?:\/\//, '');
	}

	async function copy(link: Link) {
		clearTimeout(copiedTimer);
		try {
			await navigator.clipboard.writeText(link.shortUrl);
			copiedId = link.id;
			status = `Copied ${display(link.shortUrl)}`;
			copiedTimer = setTimeout(() => (copiedId = null), 2500);
		} catch {
			copiedId = null;
			status = 'Copy failed. Select the short link and copy it.';
		}
	}

	function actions(link: ListedLink): MenuItem[] {
		return [
			...(onselect
				? [{ label: 'Show details', icon: 'info' as const, onselect: () => onselect(link) }]
				: []),
			...(analyticsHref
				? [{ label: 'View analytics', icon: 'chart' as const, href: analyticsHref(link) }]
				: []),
			{ label: 'Copy link', icon: 'copy', onselect: () => void copy(link) },
			{ label: 'Open short link', icon: 'arrowUpRight', href: link.shortUrl, external: true },
			{ label: 'Open destination', icon: 'external', href: link.destination, external: true }
		];
	}

	// A click anywhere on a row opens its details, except on the row's own controls.
	function rowClick(event: MouseEvent, link: ListedLink) {
		if (!onselect) return;
		if ((event.target as HTMLElement).closest('a, button, [popover]')) return;
		onselect(link);
	}
</script>

<section class="link-list" aria-labelledby="link-list-heading">
	<h2 id="link-list-heading" class="visually-hidden">Your links</h2>
	{#if filters}
		<form class="filters" method="get" role="search" aria-label="Filter links">
			<label class="search">
				<span class="visually-hidden">Search links</span>
				<Glyph name="search" size={20} />
				<input
					type="search"
					name="q"
					value={filters.search}
					placeholder="Search links…"
					maxlength="100"
					autocomplete="off"
					bind:this={searchInput}
				/>
			</label>
			{#if filters.domains.length > 1}
				<label class="domain">
					<span class="visually-hidden">Domain</span>
					<select
						name="domain"
						value={filters.domainId}
						onchange={(event) => event.currentTarget.form?.requestSubmit()}
					>
						<option value="">All domains</option>
						{#each filters.domains as domain (domain.id)}
							<option value={domain.id}>{domain.hostname}</option>
						{/each}
					</select>
					<Glyph name="caretDown" size={16} />
				</label>
			{/if}
		</form>
	{/if}
	<p class="visually-hidden" role="status" aria-live="polite">{status}</p>
	{#if links.length === 0}
		{#if filtered}
			<p class="empty">No links match. <a href="?">Show all links</a></p>
		{:else}
			<EmptyState title="No links yet"
				>Create your first short link using the field above.</EmptyState
			>
		{/if}
	{:else}
		<div class="columns" aria-hidden="true">
			<span>Link</span><span class="clicks-head">Clicks · 30d</span>
		</div>
		<ul class="rows">
			{#each links as link (link.id)}
				{@const site = iconHostnameOfUrl(link.destination)}
				{@const name = link.title ?? display(link.shortUrl)}
				<!-- The title button is the keyboard path; the row click is a larger target. -->
				<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
				<li
					class:selected={link.id === selectedId}
					class:highlight={link.id === highlightId && link.id !== selectedId}
					class:clickable={onselect}
					onclick={(event) => rowClick(event, link)}
				>
					<SiteIcon
						hostname={site ?? display(link.destination)}
						src={site && iconHref ? iconHref(site) : null}
						size={36}
					/>
					<div class="main">
						<span class="title-row">
							{#if onselect}
								<button
									type="button"
									class="title"
									aria-expanded={link.id === selectedId}
									aria-controls="link-details"
									onclick={() => onselect(link)}>{name}</button
								>
							{:else if analyticsHref}
								<a class="title" href={analyticsHref(link)}>{name}</a>
							{:else}
								<span class="title">{name}</span>
							{/if}
							{#if link.blocked}<Badge tone="danger">{blockLabel(link.blocked.reason)}</Badge
								>{:else if !link.enabled}<Badge>Disabled</Badge>{/if}
						</span>
						<span class="sub">
							<a class="short" href={link.shortUrl} target="_blank" rel="noopener noreferrer"
								>{link.hostname}/<strong>{link.slug}</strong></a
							>
							<span class="dot" aria-hidden="true">·</span>
							<span class="destination" title={link.destination}
								>{site ?? display(link.destination)}</span
							>
						</span>
					</div>
					{#if analyticsHref}
						<a
							class="clicks"
							href={analyticsHref(link)}
							aria-label={`${clicksText(link)} in the last 30 days for ${display(link.shortUrl)}. Open analytics.`}
							>{clicksNumber(link)}</a
						>
					{:else}
						<span class="clicks" title="Clicks in the last 30 days">{clicksNumber(link)}</span>
					{/if}
					<span class="copy">
						{#if copiedId === link.id}
							<span class="copied"><Glyph name="check" size={18} />Copied</span>
						{:else}
							<IconButton
								icon="copy"
								size="sm"
								label={`Copy ${display(link.shortUrl)}`}
								onclick={() => void copy(link)}
							/>
						{/if}
					</span>
					<Menu id="link-menu-{link.id}" label="More actions for {name}" items={actions(link)} />
				</li>
			{/each}
		</ul>
		<div class="foot">
			<span
				>{#if nextHref}Showing {numbers.format(links.length)} links{:else}{numbers.format(
						links.length
					)}
					{links.length === 1 ? 'link' : 'links'}{/if}</span
			>
			{#if nextHref}<a class="more" href={nextHref}>Next page<Glyph name="arrow" size={16} /></a
				>{/if}
		</div>
	{/if}
</section>

<style>
	.link-list {
		display: grid;
		gap: 0.75rem;
		container-type: inline-size;
	}
	.filters {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
		margin-bottom: 0.75rem;
	}
	.search,
	.domain {
		position: relative;
		display: flex;
		align-items: center;
		min-height: 3rem;
		border: 1px solid var(--color-rule);
		border-radius: var(--radius-control, 0.5rem);
		background: var(--color-input);
		color: var(--color-lead);
	}
	.search {
		flex: 1 1 18rem;
		gap: 0.75rem;
		padding: 0 1rem;
	}
	.search:focus-within,
	.domain:focus-within {
		border-color: var(--color-strong);
		outline: 1px solid var(--color-strong);
		outline-offset: -1px;
	}
	.search input {
		flex: 1;
		min-width: 0;
		align-self: stretch;
		padding: 0;
		border: 0;
		background: transparent;
		color: var(--color-strong);
		font: inherit;
		font-size: 1rem;
		outline: none;
	}
	.search input::placeholder {
		color: var(--color-lead);
	}
	.domain {
		flex: 0 1 12rem;
		color: var(--color-strong);
	}
	.domain select {
		width: 100%;
		align-self: stretch;
		padding: 0 2.5rem 0 1rem;
		border: 0;
		background: transparent;
		color: inherit;
		font: inherit;
		font-size: 1rem;
		appearance: none;
		outline: none;
	}
	.domain select option {
		background: var(--color-paper);
		color: var(--color-strong);
	}
	.domain :global(svg) {
		position: absolute;
		right: 0.9rem;
		pointer-events: none;
	}
	.columns,
	li {
		display: grid;
		grid-template-columns: 2.5rem minmax(0, 1fr) 7.5rem 6.5rem 2.25rem;
		align-items: center;
		gap: 0 1rem;
	}
	.columns {
		padding: 0 1rem 0 1.25rem;
		color: var(--color-lead);
		font-size: 0.8125rem;
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}
	.columns span:first-child {
		grid-column: 1 / 3;
	}
	.clicks-head {
		text-align: center;
		white-space: nowrap;
	}
	.rows {
		margin: 0;
		padding: 0;
		list-style: none;
		border: 1px solid var(--color-rule);
		border-radius: var(--radius-md, 0.625rem);
		background: var(--color-paper);
		overflow: hidden;
	}
	li {
		position: relative;
		min-height: 4.6rem;
		padding: 0.75rem 1rem 0.75rem 1.25rem;
	}
	li + li {
		border-top: 1px solid var(--color-rule);
	}
	.clickable {
		cursor: pointer;
	}
	.clickable:hover {
		background: var(--color-hover);
	}
	li.selected,
	li.highlight {
		background: var(--color-accent-soft);
	}
	li.selected::before {
		content: '';
		position: absolute;
		top: 0;
		bottom: 0;
		left: 0;
		width: 3px;
		background: var(--color-accent);
	}
	.main {
		display: grid;
		gap: 0.2rem;
		min-width: 0;
	}
	.title-row {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		min-width: 0;
	}
	.title {
		overflow: hidden;
		padding: 0;
		border: 0;
		background: none;
		color: var(--color-strong);
		font: inherit;
		font-size: 1.0625rem;
		font-weight: 600;
		text-align: left;
		text-overflow: ellipsis;
		white-space: nowrap;
		cursor: pointer;
	}
	a.title:hover,
	button.title:hover {
		text-decoration: underline;
		text-underline-offset: 3px;
	}
	.sub {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		min-width: 0;
		color: var(--color-lead);
		font-size: 0.9375rem;
	}
	.short {
		flex: none;
		color: var(--color-lead);
	}
	.short strong {
		color: var(--color-strong);
		font-weight: 600;
	}
	.short:hover {
		text-decoration: underline;
		text-underline-offset: 3px;
	}
	.destination {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.clicks {
		color: var(--color-strong);
		font-size: 1rem;
		font-variant-numeric: tabular-nums;
		text-align: center;
	}
	a.clicks:hover {
		text-decoration: underline;
		text-underline-offset: 3px;
	}
	.copy {
		display: flex;
		justify-content: center;
	}
	.copied {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		color: var(--color-accent-ink);
		font-size: 0.9375rem;
		font-weight: 500;
	}
	.foot {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.25rem 0.25rem 0;
		color: var(--color-lead);
		font-size: 0.9375rem;
	}
	.more {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		color: var(--color-link);
	}
	.empty {
		padding: 1.5rem 0;
		color: var(--color-lead);
	}
	.empty a {
		color: var(--color-link);
		text-decoration: underline;
	}
	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
	/* Narrow lists keep the link and its clicks; copy and the menu stay in reach. */
	@container (max-width: 34rem) {
		.columns {
			display: none;
		}
		li {
			grid-template-columns: 2.25rem minmax(0, 1fr) auto 2.25rem;
			gap: 0 0.75rem;
			padding-inline: 0.85rem 0.5rem;
		}
		.copy {
			display: none;
		}
	}
</style>
