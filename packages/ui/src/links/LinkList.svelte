<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import EmptyState from '../empty/EmptyState.svelte';
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
	}

	let { links, analyticsHref, nextHref = null, highlightId = null, iconHref }: Props = $props();
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
	<h2 id="link-list-heading">Your links</h2>
	<p class="status" role="status" aria-live="polite">{status}</p>
	{#if links.length === 0}
		<EmptyState>No links yet. Create your first short link above.</EmptyState>
	{:else}
		<ul>
			{#each links as link (link.id)}
				{@const spark = trend(link)}
				{@const site = iconHostnameOfUrl(link.destination)}
				<li class:highlight={link.id === highlightId}>
					<SiteIcon
						hostname={site ?? display(link.destination)}
						src={site && iconHref ? iconHref(site) : null}
					/>
					<div class="main">
						<a class="short" href={link.shortUrl} target="_blank" rel="noopener noreferrer"
							>{display(link.shortUrl)}</a
						>
						{#if link.blocked}<span class="badge blocked">{blockLabel(link.blocked.reason)}</span
							>{:else if !link.enabled}<span class="badge">Disabled</span>{/if}
						{#if link.title}<span class="title">{link.title}</span>{/if}
						<span class="destination" title={link.destination}>{link.destination}</span>
					</div>
					<div class="meta">
						{#if spark}
							<svg class="trend" viewBox="0 0 64 20" width="64" height="20" aria-hidden="true">
								<path d={spark.area} class="trend-area" />
								<path d={spark.line} class="trend-line" />
							</svg>
						{/if}
						{#if analyticsHref}
							<a
								class="clicks"
								href={analyticsHref(link)}
								title="Clicks in the last 30 days"
								aria-label={`${clicksText(link)} in the last 30 days for ${display(link.shortUrl)}. Open analytics.`}
								>{clicksText(link)}</a
							>
						{:else}
							<span class="clicks" title="Clicks in the last 30 days">{clicksText(link)}</span>
						{/if}
						<time datetime={link.createdAt}>{dates.format(new Date(link.createdAt))}</time>
						<button
							type="button"
							onclick={() => copy(link)}
							aria-label={`Copy ${display(link.shortUrl)}`}
							>{copiedId === link.id ? 'Copied' : 'Copy'}</button
						>
					</div>
				</li>
			{/each}
		</ul>
		{#if nextHref}<a class="more" href={nextHref}>Next page</a>{/if}
	{/if}
</section>

<style>
	.link-list {
		max-width: 44rem;
		margin-top: 1.5rem;
	}
	h2 {
		font-size: 1.05rem;
	}
	.status:empty {
		display: none;
	}
	.status {
		margin-top: 0.5rem;
		color: var(--color-muted, #667085);
		font-size: 0.85rem;
	}
	ul {
		display: grid;
		margin: 0.75rem 0 0;
		padding: 0;
		list-style: none;
		border: 1px solid var(--color-rule, #d0d5dd);
		border-radius: var(--radius-md, 8px);
		background: var(--color-paper, #fff);
	}
	li {
		display: flex;
		align-items: center;
		gap: 0.85rem;
		padding: 0.85rem 1rem;
	}
	li + li {
		border-top: 1px solid var(--color-rule, #d0d5dd);
	}
	li.highlight {
		background: var(--color-accent-soft, #fff4ed);
	}
	.main {
		display: grid;
		flex: 1;
		gap: 0.15rem;
		min-width: 0;
	}
	.short {
		color: var(--color-strong, #101828);
		font-weight: 650;
		overflow-wrap: anywhere;
	}
	.short:hover {
		text-decoration: underline;
	}
	.title {
		color: var(--color-ink, #101828);
		font-size: 0.85rem;
	}
	.destination {
		overflow: hidden;
		color: var(--color-muted, #667085);
		font-size: 0.8rem;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.badge {
		justify-self: start;
		padding: 0 0.4rem;
		border-radius: 999px;
		background: var(--color-disabled, #eaecf0);
		color: var(--color-muted, #667085);
		font-size: 0.75rem;
	}
	.badge.blocked {
		background: var(--color-danger-soft, #fee4e2);
		color: var(--color-danger, #b42318);
	}
	.meta {
		display: flex;
		flex-shrink: 0;
		align-items: center;
		gap: 0.75rem;
		color: var(--color-muted, #667085);
		font-size: 0.8rem;
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
		min-height: 40px;
		text-decoration: underline;
		text-decoration-color: var(--color-rule, #d0d5dd);
		text-underline-offset: 3px;
	}
	a.clicks:hover {
		text-decoration-color: currentColor;
	}
	button {
		min-width: 4.5rem;
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
		display: inline-block;
		margin-top: 0.75rem;
		color: var(--color-accent-ink, #b42318);
		font-size: 0.85rem;
		font-weight: 600;
	}
	@media (max-width: 40rem) {
		li {
			display: grid;
			grid-template-columns: auto minmax(0, 1fr);
			align-items: start;
			gap: 0.5rem 0.75rem;
		}
		.meta {
			grid-column: 1 / -1;
			justify-content: space-between;
		}
	}
</style>
