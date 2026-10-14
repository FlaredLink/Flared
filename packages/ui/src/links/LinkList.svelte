<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import { untrack } from 'svelte';
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
		// Address of a link's edit form. Without it, the row menu shows no Edit item.
		editHref?: (link: Link) => string;
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
		editHref,
		nextHref = null,
		highlightId = null,
		iconHref,
		filters,
		selectedId = null,
		onselect,
		searchInput = $bindable()
	}: Props = $props();
	const filtered = $derived(Boolean(filters && (filters.search || filters.domainId)));

	// The search runs as the person types. The field keeps its own text, so a response for an
	// earlier query cannot overwrite keys typed since; it follows the URL only while unfocused.
	let query = $state(untrack(() => filters?.search ?? ''));
	let searchTimer: ReturnType<typeof setTimeout> | undefined;
	$effect(() => {
		const search = filters?.search ?? '';
		if (document.activeElement !== searchInput) query = search;
	});

	function searchSoon(form: HTMLFormElement | null) {
		clearTimeout(searchTimer);
		searchTimer = setTimeout(() => {
			if (query.trim() !== (filters?.search ?? '')) form?.requestSubmit();
		}, 300);
	}
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
		<!-- SvelteKit runs this GET form in place: focus and scroll stay, and history gets no
		     entry per typed query. -->
		<form
			class="filters"
			method="get"
			role="search"
			aria-label="Filter links"
			data-sveltekit-keepfocus
			data-sveltekit-noscroll
			data-sveltekit-replacestate
			onsubmit={() => clearTimeout(searchTimer)}
		>
			<label class="search">
				<span class="visually-hidden">Search links</span>
				<Glyph name="search" size={20} />
				<input
					type="search"
					name="q"
					bind:value={query}
					oninput={(event) => searchSoon(event.currentTarget.form)}
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
			<span>Link</span><span class="clicks-head">Clicks · 30 days</span>
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
							<!-- Copy sits beside the address it copies. -->
							<a
								class="short"
								href={link.shortUrl}
								target="_blank"
								rel="noopener noreferrer"
								title="Open {display(link.shortUrl)} in a new tab"
								><span class="short-text">{link.hostname}/<strong>{link.slug}</strong></span><Glyph
									name="arrowUpRight"
									size={14}
								/></a
							>
							<span class="copy">
								{#if copiedId === link.id}
									<span class="copied"><Glyph name="check" size={16} />Copied</span>
								{:else}
									<IconButton
										icon="copy"
										size="sm"
										label={`Copy ${display(link.shortUrl)}`}
										onclick={() => void copy(link)}
									/>
								{/if}
							</span>
							<span class="destination" title={link.destination}
								><span class="arrow" aria-hidden="true">→</span>{site ??
									display(link.destination)}</span
							>
						</span>
					</div>
					{#if analyticsHref}
						<a
							class="clicks"
							href={analyticsHref(link)}
							aria-label={`${clicksText(link)} in the last 30 days for ${display(link.shortUrl)}. Open analytics.`}
							><Glyph name="chart" size={16} /><span
								>{clicksNumber(link)}<span class="unit">
									{link.clicksLast30Days === 1 ? 'click' : 'clicks'} · 30d</span
								></span
							></a
						>
					{:else}
						<span class="clicks" title="Clicks in the last 30 days"
							><span
								>{clicksNumber(link)}<span class="unit">
									{link.clicksLast30Days === 1 ? 'click' : 'clicks'} · 30d</span
								></span
							></span
						>
					{/if}
					<Menu id="link-menu-{link.id}" label="More actions for {name}" items={actions(link)} />
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
		gap: 0.75rem;
		container-type: inline-size;
	}
	/* A compact toolbar, so finding a link reads apart from creating one. */
	.filters {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}
	.search,
	.domain {
		position: relative;
		display: flex;
		align-items: center;
		min-height: 2.5rem;
		border: 1px solid var(--color-rule);
		border-radius: var(--radius-control, 0.5rem);
		background: var(--color-input);
		color: var(--color-lead);
	}
	.search {
		flex: 0 1 24rem;
		gap: 0.6rem;
		padding: 0 0.75rem;
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
		padding: 0 2.5rem 0 0.85rem;
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
		grid-template-columns: 2.5rem minmax(0, 1fr) 9rem 2.25rem;
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
		text-align: right;
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
		gap: 0.1rem;
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
		align-items: center;
		gap: 0.25rem;
		min-width: 0;
		color: var(--color-lead);
		font-size: 0.9375rem;
	}
	/* The short link gives way only after the destination has shrunk to nothing. */
	.short {
		display: inline-flex;
		flex: 0 1 auto;
		align-items: center;
		gap: 0.2rem;
		min-width: 0;
		color: var(--color-lead);
	}
	.short-text {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.short :global(svg) {
		flex: none;
		opacity: 0.7;
	}
	.short strong {
		color: var(--color-strong);
		font-weight: 600;
	}
	.short:hover .short-text {
		text-decoration: underline;
		text-underline-offset: 3px;
	}
	.copy {
		display: inline-flex;
		flex: none;
		align-items: center;
		min-height: 2.25rem;
	}
	.copied {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		padding-inline: 0.4rem;
		color: var(--color-accent-ink);
		font-size: 0.875rem;
		font-weight: 500;
	}
	.destination {
		flex: 1 1 0;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.arrow {
		margin-right: 0.4rem;
	}
	/* A chip, so the count reads as the way into analytics. */
	.clicks {
		display: inline-flex;
		align-items: center;
		justify-self: end;
		gap: 0.4rem;
		min-height: 2.25rem;
		padding: 0 0.7rem;
		border-radius: var(--radius-control, 0.5rem);
		color: var(--color-strong);
		font-size: 1rem;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}
	a.clicks {
		border: 1px solid var(--color-rule);
		background: var(--color-paper);
	}
	a.clicks :global(svg) {
		color: var(--color-lead);
	}
	a.clicks:hover {
		border-color: var(--color-strong);
	}
	.unit {
		display: none;
		color: var(--color-lead);
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
	/* Narrow lists drop the column labels, so each count carries its own unit. */
	@container (max-width: 34rem) {
		.columns {
			display: none;
		}
		.search {
			flex-basis: 100%;
		}
		li {
			grid-template-columns: 2.25rem minmax(0, 1fr) 2.25rem;
			gap: 0.4rem 0.75rem;
			padding-inline: 0.85rem 0.5rem;
		}
		.clicks {
			grid-column: 2;
			grid-row: 2;
			justify-self: start;
			min-height: 2.25rem;
			font-size: 0.9375rem;
		}
		.unit {
			display: inline;
		}
		li > :global(.trigger) {
			grid-column: 3;
			grid-row: 1 / 3;
		}
	}
</style>
