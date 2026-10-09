<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import EmptyState from '../empty/EmptyState.svelte';
	import Glyph from '../icons/Glyph.svelte';
	import SiteIcon from '../icons/SiteIcon.svelte';
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
		// Search and domain filter in the header. They submit as ?q= and ?domain= to this page,
		// which passes them to GET /v1/links. Without it, the header shows no filters.
		filters?: { search: string; domainId: string; domains: { id: string; hostname: string }[] };
	}

	let {
		links,
		analyticsHref,
		nextHref = null,
		highlightId = null,
		iconHref,
		filters
	}: Props = $props();
	const filtered = $derived(Boolean(filters && (filters.search || filters.domainId)));
	let status = $state('');
	let copiedId = $state<string | null>(null);

	const dates = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
	const numbers = new Intl.NumberFormat();

	function clicksText(link: ListedLink): string {
		if (link.clicksLast30Days === null) return 'Clicks unavailable';
		return `${numbers.format(link.clicksLast30Days)} ${link.clicksLast30Days === 1 ? 'click' : 'clicks'}`;
	}

	// A 64 by 20 trend line of the last 30 days, scaled to the busiest day; null without clicks.
	function trend(link: ListedLink): { line: string; area: string } | null {
		const daily = link.dailyClicksLast30Days;
		if (!daily || daily.length < 2) return null;
		const peak = Math.max(...daily);
		if (peak === 0) return null;
		const step = 64 / (daily.length - 1);
		const points = daily.map(
			(clicks, index) => `${(index * step).toFixed(1)},${(18 - (clicks / peak) * 16).toFixed(1)}`
		);
		return { line: `M${points.join(' L')}`, area: `M0,20 L${points.join(' L')} L64,20 Z` };
	}

	function clicksNumber(link: ListedLink): string {
		return link.clicksLast30Days === null ? '–' : numbers.format(link.clicksLast30Days);
	}

	function display(url: string): string {
		return url.replace(/^https?:\/\//, '');
	}

	async function copy(link: Link) {
		try {
			await navigator.clipboard.writeText(link.shortUrl);
			copiedId = link.id;
			status = `Copied ${display(link.shortUrl)}`;
		} catch {
			copiedId = null;
			status = 'Copy failed. Select the short link and copy it.';
		}
	}
</script>

<section class="link-list" aria-labelledby="link-list-heading">
	<div class="head">
		<h2 id="link-list-heading">
			Your links{#if !nextHref && links.length > 0}<span class="count">{links.length}</span>{/if}
		</h2>
		{#if filters}
			<form class="filters" method="get" role="search" aria-label="Filter links">
				<label class="search">
					<span class="visually-hidden">Search links</span>
					<Glyph name="search" size={18} />
					<input
						type="search"
						name="q"
						value={filters.search}
						placeholder="Search links…"
						maxlength="100"
						autocomplete="off"
					/>
				</label>
				{#if filters.domains.length > 1}
					<label>
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
					</label>
				{/if}
			</form>
		{/if}
	</div>
	<p class="status" role="status" aria-live="polite">{status}</p>
	{#if links.length === 0}
		{#if filtered}
			<p class="empty">No links match. <a href="?">Show all links</a></p>
		{:else}
			<EmptyState>No links yet. Create your first short link above.</EmptyState>
		{/if}
	{:else}
		<div class="table">
			<div class="columns" aria-hidden="true">
				<span>Link</span><span>Clicks (30 days)</span><span>Created</span><span></span>
			</div>
			<ul>
				{#each links as link (link.id)}
					{@const spark = trend(link)}
					{@const site = iconHostnameOfUrl(link.destination)}
					<li class:highlight={link.id === highlightId}>
						<div class="link">
							<SiteIcon
								hostname={site ?? display(link.destination)}
								src={site && iconHref ? iconHref(site) : null}
							/>
							<div class="main">
								{#if link.title}{#if analyticsHref}<a class="title" href={analyticsHref(link)}
											>{link.title}</a
										>{:else}<span class="title">{link.title}</span>{/if}{/if}
								<span class="short-row">
									<a class="short" href={link.shortUrl} target="_blank" rel="noopener noreferrer"
										>{display(link.shortUrl)}</a
									>
									{#if link.blocked}<span class="badge blocked"
											>{blockLabel(link.blocked.reason)}</span
										>{:else if !link.enabled}<span class="badge">Disabled</span>{/if}
								</span>
								<span class="destination" title={link.destination}
									>{site ?? display(link.destination)}</span
								>
							</div>
						</div>
						<div class="clicks-cell">
							{#if analyticsHref}
								<a
									class="clicks"
									href={analyticsHref(link)}
									title="Clicks in the last 30 days"
									aria-label={`${clicksText(link)} in the last 30 days for ${display(link.shortUrl)}. Open analytics.`}
									>{clicksNumber(link)}</a
								>
							{:else}
								<span class="clicks" title="Clicks in the last 30 days">{clicksNumber(link)}</span>
							{/if}
							{#if spark}
								<svg class="trend" viewBox="0 0 64 20" width="64" height="20" aria-hidden="true">
									<title>Daily clicks, last 30 days</title>
									<path d={spark.area} class="trend-area" />
									<path d={spark.line} class="trend-line" />
								</svg>
							{/if}
						</div>
						<time datetime={link.createdAt}>{dates.format(new Date(link.createdAt))}</time>
						<button
							type="button"
							onclick={() => copy(link)}
							aria-label={`Copy ${display(link.shortUrl)}`}
							><Glyph name="copy" size={16} />{copiedId === link.id ? 'Copied' : 'Copy'}</button
						>
					</li>
				{/each}
			</ul>
		</div>
		{#if nextHref}<a class="more" href={nextHref}>Next page</a>{/if}
	{/if}
</section>

<style>
	.link-list {
		display: grid;
		gap: 0.75rem;
		margin-top: 1.5rem;
		padding: 1.25rem 1.5rem;
		border: 1px solid var(--color-rule, #eaecf0);
		border-radius: var(--radius-lg, 12px);
		background: var(--color-surface, #fff);
		container-type: inline-size;
	}
	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem 1rem;
	}
	h2 {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		color: var(--color-strong, #101828);
		font-size: 1.2rem;
	}
	.count {
		min-width: 1.75rem;
		padding: 0.1rem 0.5rem;
		border-radius: 999px;
		background: var(--color-disabled, #f2f4f7);
		color: var(--color-ink, #344054);
		font-size: 0.8rem;
		font-weight: 600;
		text-align: center;
	}
	.filters {
		display: flex;
		flex: 1 1 18rem;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 0.5rem;
	}
	.search {
		display: flex;
		flex: 1 1 14rem;
		align-items: center;
		gap: 0.5rem;
		max-width: 20rem;
		padding-left: 0.75rem;
		border: 1px solid var(--color-rule, #d0d5dd);
		border-radius: var(--radius-sm, 6px);
		background: var(--color-input, #fff);
		color: var(--color-muted, #667085);
	}
	.search:focus-within {
		border-color: var(--color-muted, #667085);
		outline: 1px solid var(--color-muted, #667085);
		outline-offset: -1px;
	}
	.search input {
		flex: 1;
		min-width: 0;
		min-height: 42px;
		padding: 0.5rem 0.75rem 0.5rem 0;
		border: 0;
		background: none;
		color: var(--color-ink, #101828);
		font: inherit;
		font-size: 0.9rem;
	}
	.search input:focus-visible {
		outline: none;
	}
	select {
		min-height: 44px;
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--color-rule, #d0d5dd);
		border-radius: var(--radius-sm, 6px);
		background: var(--color-input, #fff);
		color: var(--color-ink, #101828);
		font: inherit;
		font-size: 0.9rem;
	}
	.status:empty {
		display: none;
	}
	.status,
	.empty {
		color: var(--color-muted, #667085);
		font-size: 0.85rem;
	}
	.empty a {
		color: var(--color-strong, #101828);
		text-decoration: underline;
	}
	.columns {
		display: none;
		padding: 0 0 0.6rem;
		border-bottom: 1px solid var(--color-rule, #eaecf0);
		color: var(--color-muted, #667085);
		font-size: 0.8rem;
		font-weight: 550;
	}
	ul {
		display: grid;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	li {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		gap: 0.5rem 1rem;
		padding: 0.9rem 0;
	}
	li + li {
		border-top: 1px solid var(--color-rule, #eaecf0);
	}
	li.highlight {
		margin-inline: -0.75rem;
		padding-inline: 0.75rem;
		border-radius: var(--radius-md, 8px);
		background: var(--color-accent-soft, #fff4ed);
	}
	.link {
		display: flex;
		grid-column: 1 / -1;
		align-items: center;
		gap: 0.85rem;
		min-width: 0;
	}
	.main {
		display: grid;
		gap: 0.1rem;
		min-width: 0;
	}
	.title {
		overflow: hidden;
		color: var(--color-strong, #101828);
		font-weight: 650;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	a.title:hover {
		text-decoration: underline;
	}
	.short-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.4rem;
	}
	.short {
		color: var(--color-accent-ink, #b93815);
		font-size: 0.9rem;
		font-weight: 550;
		overflow-wrap: anywhere;
	}
	.short:hover {
		text-decoration: underline;
	}
	.destination {
		overflow: hidden;
		color: var(--color-muted, #667085);
		font-size: 0.8rem;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.badge {
		padding: 0 0.45rem;
		border-radius: 999px;
		background: var(--color-disabled, #eaecf0);
		color: var(--color-muted, #667085);
		font-size: 0.75rem;
	}
	.badge.blocked {
		background: var(--color-danger-soft, #fee4e2);
		color: var(--color-danger, #b42318);
	}
	.clicks-cell {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}
	.trend {
		flex: none;
		overflow: visible;
	}
	.trend-area {
		fill: var(--color-chart-fill, rgb(255 237 213 / 0.5));
	}
	.trend-line {
		fill: none;
		stroke: var(--color-accent-ink, #c4561d);
		stroke-width: 1.5;
		stroke-linejoin: round;
	}
	.clicks {
		color: var(--color-ink, #101828);
		font-variant-numeric: tabular-nums;
		font-weight: 600;
		white-space: nowrap;
	}
	a.clicks {
		display: inline-flex;
		align-items: center;
		min-width: 2.5rem;
		min-height: 40px;
		text-decoration: underline;
		text-decoration-color: var(--color-rule, #d0d5dd);
		text-underline-offset: 3px;
	}
	a.clicks:hover {
		text-decoration-color: currentColor;
	}
	time {
		color: var(--color-muted, #667085);
		font-size: 0.85rem;
		white-space: nowrap;
	}
	button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.4rem;
		min-width: 5.5rem;
		min-height: 40px;
		padding: 0.4rem 0.8rem;
		border: 1px solid var(--color-rule, #d0d5dd);
		border-radius: var(--radius-sm, 6px);
		background: var(--color-paper, #fff);
		color: var(--color-ink, #101828);
		font-size: 0.8rem;
		font-weight: 600;
	}
	button:hover {
		border-color: var(--color-muted, #667085);
	}
	.more {
		justify-self: start;
		color: var(--color-accent-ink, #b42318);
		font-size: 0.85rem;
		font-weight: 600;
	}
	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: nowrap;
	}
	/* Columns once the list has room: link, clicks, created, copy. */
	@container (min-width: 46rem) {
		.columns,
		li {
			display: grid;
			grid-template-columns: minmax(0, 1fr) 11rem 8rem 6rem;
			align-items: center;
			gap: 1rem;
		}
		.link {
			grid-column: auto;
		}
		.columns span:last-child,
		li > button {
			justify-self: end;
		}
	}
	@container (max-width: 46rem) {
		li time {
			display: none;
		}
	}
</style>
