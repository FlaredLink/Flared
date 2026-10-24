<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import type {
		DimensionViews,
		LinkAnalytics as LinkAnalyticsData,
		PageAnalytics
	} from '@flared/contracts/analytics';
	import LinkAnalytics from '../analytics/LinkAnalytics.svelte';

	interface Range {
		label: string;
		href: string;
		current: boolean;
	}

	interface Props {
		analytics: PageAnalytics;
		ranges?: Range[];
		navigate?: (href: string) => void;
		iconHref?: (hostname: string) => string;
		// The link page of a button, such as "/app/links/abc".
		linkHref?: (linkId: string) => string;
	}

	let { analytics, ranges = [], navigate, iconHref, linkHref }: Props = $props();
	const id = $props.id();
	const numbers = new Intl.NumberFormat();

	// The link view draws counts from its click fields; a page passes its views there.
	const rows = (list: DimensionViews[]) =>
		list.map((row) => ({ value: row.value, clicks: row.views }));
	const shown = $derived<LinkAnalyticsData>({
		linkId: analytics.pageId,
		from: analytics.from,
		to: analytics.to,
		total: analytics.views,
		days: analytics.days.map((day) => ({ day: day.day, clicks: day.views })),
		countries: rows(analytics.countries),
		devices: rows(analytics.devices),
		referrers: rows(analytics.referrers),
		browsers: rows(analytics.browsers),
		operatingSystems: rows(analytics.operatingSystems),
		asOf: analytics.asOf
	});
	const buttonClicks = $derived(analytics.buttons.reduce((total, row) => total + row.clicks, 0));
	const peak = $derived(Math.max(0, ...analytics.buttons.map((row) => row.clicks)));
</script>

<LinkAnalytics
	analytics={shown}
	{ranges}
	{navigate}
	{iconHref}
	unit="view"
	secondKpi={{ label: 'Button clicks', value: numbers.format(buttonClicks) }}
	emptyText="Open the page in a browser; the view shows here within a few minutes."
>
	<section class="buttons" aria-labelledby="{id}-buttons">
		<h3 id="{id}-buttons">Buttons</h3>
		{#if analytics.buttons.length === 0}
			<p class="none">This page has no buttons.</p>
		{:else}
			<ol class="rows">
				{#each analytics.buttons as row (row.linkId)}
					<li>
						<span
							class="fill"
							style:width={`${peak === 0 ? 0 : (row.clicks / peak) * 100}%`}
							aria-hidden="true"
						></span>
						{#if linkHref}
							<a class="name" href={linkHref(row.linkId)}>{row.label}</a>
						{:else}
							<span class="name">{row.label}</span>
						{/if}
						<span class="count"
							>{numbers.format(row.clicks)}<span class="visually-hidden"
								>{row.clicks === 1 ? ' click' : ' clicks'}</span
							></span
						>
					</li>
				{/each}
			</ol>
			<p class="note">
				Clicks that came from this page. Browsers that hide where a visitor came from are not
				counted here; the link's own page counts them.
			</p>
		{/if}
	</section>
</LinkAnalytics>

<style>
	.buttons {
		display: grid;
		grid-column: 1 / -1;
		align-content: start;
		gap: 0.375rem;
		min-width: 0;
		padding: 0.875rem 0.375rem;
		border-radius: 0.75rem;
		background: var(--color-surface);
		box-shadow: var(--shadow-ring);
	}
	h3 {
		margin: 0 0.5rem 0.25rem;
		color: var(--color-strong);
		font-size: 0.9375rem;
		font-weight: 600;
	}
	.rows {
		display: grid;
		gap: 0.125rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.rows li {
		position: relative;
		display: flex;
		align-items: center;
		gap: 0.75rem;
		min-height: 2.25rem;
		padding: 0 0.5rem;
	}
	.fill {
		position: absolute;
		inset: 0.125rem auto 0.125rem 0;
		border-radius: 0.375rem;
		background: var(--color-surface-2);
	}
	.name,
	.count {
		position: relative;
	}
	.name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		color: var(--color-strong);
		font-size: 0.875rem;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	a.name:hover {
		text-decoration: underline;
		text-underline-offset: 3px;
	}
	.count {
		color: var(--color-muted);
		font-size: 0.875rem;
		font-variant-numeric: tabular-nums;
	}
	.none,
	.note {
		margin: 0 0.5rem;
		color: var(--color-subtle);
		font-size: 0.8125rem;
	}
	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
</style>
