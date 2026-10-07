<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import EmptyState from '../empty/EmptyState.svelte';
	import type { DimensionClicks, LinkAnalytics } from '@flared/contracts/analytics';

	interface Range {
		label: string;
		href: string;
		current: boolean;
	}

	interface Props {
		analytics: LinkAnalytics;
		// Range choices as links, so the page works without JavaScript.
		ranges?: Range[];
	}

	let { analytics, ranges = [] }: Props = $props();

	const numbers = new Intl.NumberFormat();
	const dayLabel = new Intl.DateTimeFormat(undefined, {
		month: 'short',
		day: 'numeric',
		timeZone: 'UTC'
	});
	const time = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
	let regions: Intl.DisplayNames | null = null;
	try {
		regions = new Intl.DisplayNames(undefined, { type: 'region' });
	} catch {
		regions = null;
	}

	const deviceNames: Record<string, string> = {
		desktop: 'Desktop',
		mobile: 'Mobile',
		tablet: 'Tablet',
		unknown: 'Unknown'
	};

	function formatDay(day: string): string {
		return dayLabel.format(new Date(`${day}T00:00:00Z`));
	}

	function country(value: string): string {
		if (value === 'unknown') return 'Unknown';
		return regions?.of(value) ?? value;
	}

	function referrer(value: string): string {
		if (value === 'unknown') return 'Direct or unknown';
		if (value === 'other') return 'Other sites';
		return value;
	}

	const peak = $derived(Math.max(0, ...analytics.days.map((day) => day.clicks)));
	// A clean top tick: 1, 2, or 5 times a power of ten, at or above the peak.
	const scale = $derived.by(() => {
		if (peak <= 1) return 1;
		const power = 10 ** Math.floor(Math.log10(peak));
		return [1, 2, 5, 10].map((step) => step * power).find((tick) => tick >= peak) ?? peak;
	});

	const breakdowns = $derived([
		{ id: 'countries', title: 'Countries', rows: analytics.countries, name: country },
		{
			id: 'devices',
			title: 'Devices',
			rows: analytics.devices,
			name: (v: string) => deviceNames[v] ?? v
		},
		{ id: 'referrers', title: 'Referrers', rows: analytics.referrers, name: referrer }
	]);

	function share(rows: DimensionClicks[], clicks: number): number {
		const sum = rows.reduce((total, row) => total + row.clicks, 0);
		return sum === 0 ? 0 : (clicks / sum) * 100;
	}
</script>

<section class="analytics" aria-labelledby="analytics-heading">
	<div class="head">
		<div>
			<h2 id="analytics-heading">Clicks</h2>
			<p class="total">
				<span class="figure">{numbers.format(analytics.total)}</span>
				<span class="range">{formatDay(analytics.from)} – {formatDay(analytics.to)} (UTC)</span>
			</p>
		</div>
		{#if ranges.length > 0}
			<nav class="ranges" aria-label="Date range">
				{#each ranges as range (range.href)}
					<a href={range.href} aria-current={range.current ? 'page' : undefined}>{range.label}</a>
				{/each}
			</nav>
		{/if}
	</div>

	{#if analytics.total === 0}
		<EmptyState>
			No clicks in this range yet. Open the short link in a browser; the click shows here within a
			few minutes.
		</EmptyState>
	{:else}
		<figure class="chart">
			<div
				class="plot"
				role="img"
				aria-label={`Daily clicks from ${formatDay(analytics.from)} to ${formatDay(analytics.to)}. Highest day: ${numbers.format(peak)}.`}
			>
				<span class="tick top" aria-hidden="true">{numbers.format(scale)}</span>
				<span class="tick zero" aria-hidden="true">0</span>
				<div class="columns" aria-hidden="true">
					{#each analytics.days as day (day.day)}
						<div class="column">
							{#if day.clicks > 0}
								<span class="bar" style:height={`${(day.clicks / scale) * 100}%`}></span>
							{/if}
							<span class="tip">{formatDay(day.day)}: {numbers.format(day.clicks)}</span>
						</div>
					{/each}
				</div>
			</div>
			<figcaption class="axis" aria-hidden="true">
				<span>{formatDay(analytics.from)}</span>
				<span>{formatDay(analytics.to)}</span>
			</figcaption>
		</figure>
		<details class="table">
			<summary>Daily numbers</summary>
			<table>
				<thead><tr><th scope="col">Day (UTC)</th><th scope="col">Clicks</th></tr></thead>
				<tbody>
					{#each analytics.days as day (day.day)}
						<tr><td>{formatDay(day.day)}</td><td>{numbers.format(day.clicks)}</td></tr>
					{/each}
				</tbody>
			</table>
		</details>

		<div class="breakdowns">
			{#each breakdowns as breakdown (breakdown.id)}
				<section aria-labelledby={`${breakdown.id}-heading`}>
					<h3 id={`${breakdown.id}-heading`}>{breakdown.title}</h3>
					<ol>
						{#each breakdown.rows.slice(0, 10) as row (row.value)}
							<li>
								<span class="name">{breakdown.name(row.value)}</span>
								<span class="count">{numbers.format(row.clicks)}</span>
								<span class="meter" aria-hidden="true"
									><span style:width={`${share(breakdown.rows, row.clicks)}%`}></span></span
								>
							</li>
						{/each}
					</ol>
				</section>
			{/each}
		</div>
	{/if}
	<p class="as-of">
		Updated {time.format(new Date(analytics.asOf))}. New clicks can take up to five minutes to
		appear. Link previews and known bots are not counted.
	</p>
</section>

<style>
	.analytics {
		display: grid;
		gap: 1.25rem;
		max-width: 44rem;
	}
	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: end;
		justify-content: space-between;
		gap: 1rem;
	}
	h2 {
		font-size: 1.05rem;
	}
	.total {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.5rem;
		margin-top: 0.25rem;
	}
	.figure {
		color: var(--color-strong, #101828);
		font-size: 2rem;
		font-weight: 650;
	}
	.range,
	.as-of {
		color: var(--color-muted, #667085);
		font-size: 0.85rem;
	}
	.ranges {
		display: flex;
		gap: 0.25rem;
	}
	.ranges a {
		display: inline-flex;
		align-items: center;
		min-height: 40px;
		padding: 0 0.8rem;
		border: 1px solid var(--color-rule, #d0d5dd);
		border-radius: var(--radius-sm, 6px);
		color: var(--color-ink, #101828);
		font-size: 0.8rem;
		font-weight: 600;
	}
	.ranges a[aria-current='page'] {
		border-color: var(--color-ink, #101828);
	}
	.chart {
		margin: 0;
	}
	.plot {
		position: relative;
		height: 10rem;
		padding-left: 2.5rem;
		border-bottom: 1px solid var(--color-rule, #d0d5dd);
	}
	.tick {
		position: absolute;
		left: 0;
		color: var(--color-muted, #667085);
		font-size: 0.75rem;
		font-variant-numeric: tabular-nums;
		line-height: 1;
	}
	.tick.top {
		top: 0;
	}
	.tick.zero {
		bottom: 0;
	}
	.plot::before {
		position: absolute;
		top: 0.4rem;
		right: 0;
		left: 2.5rem;
		border-top: 1px solid var(--color-rule, #d0d5dd);
		content: '';
	}
	.columns {
		display: flex;
		height: 100%;
		padding-top: 0.4rem;
	}
	.column {
		position: relative;
		display: flex;
		flex: 1;
		align-items: end;
		justify-content: center;
		min-width: 0;
		padding: 0 1px;
	}
	.bar {
		width: 100%;
		max-width: 24px;
		min-height: 2px;
		border-radius: 4px 4px 0 0;
		background: var(--color-chart-bar, var(--color-accent-ink, #c4561d));
	}
	.tip {
		position: absolute;
		bottom: calc(100% + 0.25rem);
		z-index: 1;
		display: none;
		padding: 0.25rem 0.5rem;
		border: 1px solid var(--color-rule, #d0d5dd);
		border-radius: var(--radius-sm, 6px);
		background: var(--color-paper, #fff);
		color: var(--color-ink, #101828);
		font-size: 0.75rem;
		white-space: nowrap;
		pointer-events: none;
	}
	.column:hover .tip {
		display: block;
	}
	.column:hover .bar {
		opacity: 0.8;
	}
	.axis {
		display: flex;
		justify-content: space-between;
		padding: 0.35rem 0 0 2.5rem;
		color: var(--color-muted, #667085);
		font-size: 0.75rem;
	}
	.table summary {
		color: var(--color-muted, #667085);
		font-size: 0.85rem;
		cursor: pointer;
	}
	table {
		margin-top: 0.5rem;
		border-collapse: collapse;
		font-size: 0.85rem;
	}
	th,
	td {
		padding: 0.25rem 1.5rem 0.25rem 0;
		text-align: left;
	}
	td + td,
	th + th {
		font-variant-numeric: tabular-nums;
		text-align: right;
	}
	.breakdowns {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
		gap: 1.25rem;
	}
	h3 {
		font-size: 0.9rem;
	}
	ol {
		display: grid;
		gap: 0.5rem;
		margin: 0.5rem 0 0;
		padding: 0;
		list-style: none;
	}
	li {
		display: grid;
		grid-template-columns: 1fr auto;
		gap: 0.2rem 0.5rem;
		font-size: 0.85rem;
	}
	.name {
		overflow: hidden;
		color: var(--color-ink, #101828);
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.count {
		color: var(--color-muted, #667085);
		font-variant-numeric: tabular-nums;
	}
	.meter {
		grid-column: 1 / -1;
		height: 4px;
		border-radius: 2px;
		background: var(--color-accent-soft, #fff4ed);
	}
	.meter span {
		display: block;
		height: 100%;
		border-radius: 2px;
		background: var(--color-chart-bar, var(--color-accent-ink, #c4561d));
	}
</style>
