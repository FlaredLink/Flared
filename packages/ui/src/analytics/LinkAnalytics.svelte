<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import EmptyState from '../empty/EmptyState.svelte';
	import Glyph from '../icons/Glyph.svelte';
	import Select from '../atoms/Select.svelte';
	import Tabs, { tabPanelId, tabId, type TabItem } from '../molecules/Tabs.svelte';
	import DimensionIcon, { type IconKind } from './DimensionIcon.svelte';
	import type { DimensionClicks, LinkAnalytics } from '@flared/contracts/analytics';

	interface Range {
		label: string;
		href: string;
		current: boolean;
	}

	interface Props {
		analytics: LinkAnalytics;
		// Range choices. Each is an address, so a page can also offer them as links.
		ranges?: Range[];
		// Opens a range. Without it, the page loads the range's address.
		navigate?: (href: string) => void;
		// Address of a site's icon on the app's origin. Without it, referrers show a letter.
		iconHref?: (hostname: string) => string;
	}

	let { analytics, ranges = [], navigate, iconHref }: Props = $props();
	const id = $props.id();

	const numbers = new Intl.NumberFormat();
	const dayLabel = new Intl.DateTimeFormat(undefined, {
		month: 'short',
		day: 'numeric',
		timeZone: 'UTC'
	});
	// UTC, as the chart and the table, with the zone named.
	const time = new Intl.DateTimeFormat(undefined, {
		dateStyle: 'medium',
		timeStyle: 'short',
		timeZone: 'UTC'
	});
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
	const browserNames: Record<string, string> = {
		chrome: 'Chrome',
		safari: 'Safari',
		firefox: 'Firefox',
		edge: 'Edge',
		samsung: 'Samsung Internet',
		opera: 'Opera',
		other: 'Other',
		unknown: 'Unknown'
	};
	const osNames: Record<string, string> = {
		ios: 'iOS',
		android: 'Android',
		windows: 'Windows',
		macos: 'macOS',
		linux: 'Linux',
		chromeos: 'ChromeOS',
		other: 'Other',
		unknown: 'Unknown'
	};

	const clickCount = (clicks: number) =>
		`${numbers.format(clicks)} ${clicks === 1 ? 'click' : 'clicks'}`;

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

	const sum = (rows: DimensionClicks[]) => rows.reduce((total, row) => total + row.clicks, 0);

	const currentRange = $derived(ranges.find((range) => range.current)?.href ?? '');
	function chooseRange(href: string) {
		if (navigate) navigate(href);
		else window.location.assign(href);
	}

	const peak = $derived(Math.max(0, ...analytics.days.map((day) => day.clicks)));
	// A round top tick at or above the peak, close enough that the line fills the plot.
	const scale = $derived.by(() => {
		if (peak <= 1) return 1;
		const power = 10 ** Math.floor(Math.log10(peak));
		const steps = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
		return (
			steps.map((step) => step * power).find((tick) => tick >= peak && Number.isInteger(tick)) ??
			peak
		);
	});
	// Whole-number gridlines: three or four even steps where the top tick allows them.
	const ticks = $derived.by(() => {
		const count = [3, 4, 2].find((parts) => scale % parts === 0) ?? 1;
		return Array.from({ length: count + 1 }, (_, index) => (scale / count) * index);
	});

	// The plot is 100 units high and one unit wide per day; the SVG stretches to the box.
	const points = $derived.by(() => {
		const values = analytics.days.map((day) => 100 - (day.clicks / scale) * 100);
		const ys = values.length === 1 ? [values[0], values[0]] : values;
		return ys.map((y, x) => `${x},${y.toFixed(2)}`);
	});
	const width = $derived(Math.max(1, points.length - 1));
	const line = $derived(`M${points.join(' L')}`);
	const area = $derived(`M0,100 L${points.join(' L')} L${width},100 Z`);
	// Up to four day labels, evenly spaced, always with the first and the last day.
	const labels = $derived.by(() => {
		const last = analytics.days.length - 1;
		const indexes = [0, 1, 2, 3].map((step) => Math.round((step * last) / 3));
		return [...new Set(indexes)].map((index) => ({
			day: analytics.days[index].day,
			left: last === 0 ? 0 : (index / last) * 100
		}));
	});
	// Dots on every day stay readable up to about a month.
	const showDots = $derived(analytics.days.length <= 31);

	const countries = $derived(analytics.countries.filter((row) => row.value !== 'unknown').length);

	interface Breakdown {
		id: string;
		title: string;
		kind: IconKind;
		rows: DimensionClicks[];
		name: (value: string) => string;
		// Set for browser and OS: the clicks that carry the field, and the noun for the note.
		recorded?: { clicks: number; noun: string };
	}

	const technology = $derived.by(() => {
		const list: Breakdown[] = [
			{
				id: 'devices',
				title: 'Devices',
				kind: 'device',
				rows: analytics.devices,
				name: (v) => deviceNames[v] ?? v
			}
		];
		if (analytics.browsers)
			list.push({
				id: 'browsers',
				title: 'Browsers',
				kind: 'browser',
				rows: analytics.browsers,
				name: (v) => browserNames[v] ?? v,
				recorded: { clicks: sum(analytics.browsers), noun: 'browser' }
			});
		if (analytics.operatingSystems)
			list.push({
				id: 'systems',
				title: 'Operating systems',
				kind: 'os',
				rows: analytics.operatingSystems,
				name: (v) => osNames[v] ?? v,
				recorded: { clicks: sum(analytics.operatingSystems), noun: 'system' }
			});
		return list;
	});
	const technologyTabs = $derived<TabItem[]>(
		technology.map((item) => ({ value: item.id, label: item.title }))
	);
	let technologyTab = $state('devices');
	const shownTechnology = $derived(
		technology.find((item) => item.id === technologyTab) ?? technology[0]
	);

	const countryBreakdown = $derived<Breakdown>({
		id: 'countries',
		title: 'Countries',
		kind: 'country',
		rows: analytics.countries,
		name: country
	});
	const referrerBreakdown = $derived<Breakdown>({
		id: 'referrers',
		title: 'Referrers',
		kind: 'referrer',
		rows: analytics.referrers,
		name: referrer
	});

	// Lists show four rows until the person asks for all of them.
	const preview = 4;
	let expanded = $state<Record<string, boolean>>({});

	function share(rows: DimensionClicks[], clicks: number): number {
		const total = sum(rows);
		return total === 0 ? 0 : (clicks / total) * 100;
	}

	function percent(value: number): string {
		return value > 0 && value < 1 ? '<1%' : `${Math.round(value)}%`;
	}
</script>

{#snippet rows(breakdown: Breakdown, bars: boolean)}
	{#if breakdown.rows.length > 0}
		{@const open = expanded[breakdown.id] ?? false}
		<ol class="rows" class:bars id="{id}-{breakdown.id}-rows">
			{#each open ? breakdown.rows : breakdown.rows.slice(0, preview) as row (row.value)}
				{@const value = share(breakdown.rows, row.clicks)}
				<li>
					<DimensionIcon kind={breakdown.kind} value={row.value} {iconHref} />
					<span class="name">{breakdown.name(row.value)}</span>
					<span class="share" title={clickCount(row.clicks)}
						>{percent(value)}<span class="visually-hidden">, {clickCount(row.clicks)}</span></span
					>
					{#if bars}<span class="meter" aria-hidden="true"
							><span style:width={`${value}%`}></span></span
						>{/if}
				</li>
			{/each}
		</ol>
		{#if breakdown.rows.length > preview}
			<button
				type="button"
				class="all"
				aria-expanded={open}
				aria-controls="{id}-{breakdown.id}-rows"
				onclick={() => (expanded = { ...expanded, [breakdown.id]: !open })}
				>{open ? 'Show fewer' : `View all ${breakdown.title.toLocaleLowerCase()}`}<Glyph
					name={open ? 'caretUp' : 'arrow'}
					size={16}
				/></button
			>
		{/if}
	{:else}
		<p class="none">No data in this range.</p>
	{/if}
	{#if breakdown.recorded && breakdown.recorded.clicks < analytics.total}
		<p class="note">
			{breakdown.recorded.clicks === 0
				? `No ${breakdown.recorded.noun} data for these clicks yet. Recording started after them.`
				: `Based on ${numbers.format(breakdown.recorded.clicks)} of ${numbers.format(analytics.total)} clicks. Older clicks have no ${breakdown.recorded.noun} data.`}
		</p>
	{/if}
{/snippet}

<section class="analytics" aria-labelledby="{id}-heading">
	<div class="bar">
		<h2 id="{id}-heading" class="tab">Analytics</h2>
		<div class="period">
			{#if ranges.length > 0}
				<Select
					icon="calendar"
					value={currentRange}
					aria-label="Period"
					onchange={(event) => chooseRange(event.currentTarget.value)}
				>
					{#each ranges as range (range.href)}
						<option value={range.href}>Last {range.label}</option>
					{/each}
				</Select>
			{/if}
			<p class="dates">{formatDay(analytics.from)} – {formatDay(analytics.to)} · UTC</p>
		</div>
	</div>

	<dl class="stats">
		<div>
			<dt>Total clicks</dt>
			<dd>{numbers.format(analytics.total)}</dd>
		</div>
		<div>
			<dt>{countries === 1 ? 'Country' : 'Countries'}</dt>
			<dd>{numbers.format(countries)}</dd>
		</div>
	</dl>

	{#if analytics.total === 0}
		<EmptyState title="No clicks in this range yet" icon="chartLine">
			Open the short link in a browser; the click shows here within a few minutes.
		</EmptyState>
	{:else}
		<figure class="chart">
			<figcaption class="visually-hidden">Clicks over time</figcaption>
			<div
				class="plot"
				role="img"
				aria-label={`Daily clicks from ${formatDay(analytics.from)} to ${formatDay(analytics.to)}. Highest day: ${numbers.format(peak)}.`}
			>
				{#each ticks as tick (tick)}
					<span class="tick" style:top="{100 - (tick / scale) * 100}%" aria-hidden="true"
						>{numbers.format(tick)}</span
					>
				{/each}
				<div class="area" aria-hidden="true">
					{#each ticks as tick (tick)}
						<span class="grid" class:base={tick === 0} style:top="{100 - (tick / scale) * 100}%"
						></span>
					{/each}
					<svg viewBox={`0 0 ${width} 100`} preserveAspectRatio="none">
						<defs>
							<linearGradient id={`fill-${id}`} x1="0" x2="0" y1="0" y2="1">
								<stop offset="0" class="fill-top" />
								<stop offset="1" class="fill-bottom" />
							</linearGradient>
						</defs>
						<path d={area} fill={`url(#fill-${id})`} />
						<path d={line} class="line" vector-effect="non-scaling-stroke" />
					</svg>
					<div
						class="columns"
						style:--half={analytics.days.length > 1 ? `${50 / (analytics.days.length - 1)}%` : '0%'}
					>
						{#each analytics.days as day (day.day)}
							<div class="column">
								<span
									class="dot"
									class:always={showDots}
									style:bottom={`${(day.clicks / scale) * 100}%`}
								></span>
								<span class="tip">{formatDay(day.day)}: {numbers.format(day.clicks)}</span>
							</div>
						{/each}
					</div>
				</div>
			</div>
			<div class="axis" aria-hidden="true">
				{#each labels as label (label.day)}
					<span style:left={`${label.left}%`}>{formatDay(label.day)}</span>
				{/each}
			</div>
		</figure>
		<details class="daily">
			<summary><Glyph name="caretDown" size={18} />Daily numbers</summary>
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
			<section class="breakdown" aria-labelledby="{id}-countries">
				<h3 id="{id}-countries">Countries</h3>
				{@render rows(countryBreakdown, false)}
			</section>
			<section class="breakdown" aria-labelledby="{id}-technology">
				<h3 id="{id}-technology" class="visually-hidden">Devices and software</h3>
				{#if technologyTabs.length > 1}
					<Tabs
						items={technologyTabs}
						bind:value={technologyTab}
						label="Devices and software"
						idPrefix="{id}-tech"
						size="sm"
					/>
					<div
						role="tabpanel"
						id={tabPanelId(`${id}-tech`, shownTechnology.id)}
						aria-labelledby={tabId(`${id}-tech`, shownTechnology.id)}
						class="panel"
					>
						{@render rows(shownTechnology, true)}
					</div>
				{:else}
					<p class="single-title" aria-hidden="true">Devices</p>
					{@render rows(shownTechnology, true)}
				{/if}
			</section>
			<section class="breakdown" aria-labelledby="{id}-referrers">
				<h3 id="{id}-referrers">Referrers</h3>
				{@render rows(referrerBreakdown, false)}
			</section>
		</div>
	{/if}
	<p class="as-of">
		<Glyph name="refresh" size={18} />
		<span
			>Updated {time.format(new Date(analytics.asOf))} UTC. New clicks can take up to five minutes to
			appear.<span class="sep" aria-hidden="true">·</span>Link previews and known bots are not
			counted.</span
		>
	</p>
</section>

<style>
	.analytics {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 1.5rem;
		container-type: inline-size;
	}
	.bar {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		justify-content: space-between;
		gap: 0.75rem 1.5rem;
		box-shadow: inset 0 -1px var(--color-rule);
	}
	.tab {
		padding: 0.5rem 0.25rem 0.6rem;
		border-bottom: 2px solid var(--color-accent);
		color: var(--color-strong);
		font-size: 1.1875rem;
		font-weight: 650;
		letter-spacing: -0.02em;
	}
	.period {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem 1rem;
		padding-bottom: 0.6rem;
	}
	.dates {
		color: var(--color-lead);
		font-size: 0.9375rem;
		white-space: nowrap;
	}
	.stats {
		display: flex;
		flex-wrap: wrap;
		margin: 0;
	}
	.stats div {
		display: grid;
		gap: 0.15rem;
		padding-right: 3.5rem;
	}
	.stats div + div {
		padding-left: 3.5rem;
		border-left: 1px solid var(--color-rule);
	}
	.stats dd {
		margin: 0;
		color: var(--color-strong);
		font-size: 2.5rem;
		font-weight: 750;
		letter-spacing: -0.04em;
		line-height: 1.1;
		font-variant-numeric: tabular-nums;
	}
	.stats dt {
		order: 2;
		color: var(--color-lead);
		font-size: 0.875rem;
		letter-spacing: 0.06em;
		text-transform: uppercase;
	}
	.chart {
		margin: 0;
	}
	.plot {
		position: relative;
		height: 13rem;
		margin-left: 2.75rem;
	}
	.tick {
		position: absolute;
		right: calc(100% + 0.75rem);
		color: var(--color-lead);
		font-size: 0.8125rem;
		font-variant-numeric: tabular-nums;
		transform: translateY(-50%);
	}
	.area {
		position: absolute;
		inset: 0;
	}
	.grid {
		position: absolute;
		right: 0;
		left: 0;
		border-top: 1px dashed var(--color-rule);
	}
	.grid.base {
		border-top-style: solid;
	}
	svg {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		overflow: visible;
	}
	.fill-top {
		stop-color: var(--color-accent);
		stop-opacity: 0.2;
	}
	.fill-bottom {
		stop-color: var(--color-accent);
		stop-opacity: 0;
	}
	.line {
		fill: none;
		stroke: var(--color-accent);
		stroke-width: 2;
		stroke-linejoin: round;
		stroke-linecap: round;
	}
	/* One column per day, centred on its point: the first and last columns reach half a column
	 * past the ends of the line. */
	.columns {
		position: absolute;
		inset: 0;
		display: flex;
		margin: 0 calc(-1 * var(--half));
	}
	.column {
		position: relative;
		flex: 1;
		min-width: 0;
	}
	.dot {
		position: absolute;
		left: 50%;
		display: none;
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--color-accent);
		transform: translate(-50%, 50%);
	}
	.dot.always {
		display: block;
	}
	.tip {
		position: absolute;
		bottom: calc(100% + 0.25rem);
		left: 50%;
		z-index: 1;
		display: none;
		padding: 0.25rem 0.5rem;
		border: 1px solid var(--color-rule);
		border-radius: var(--radius-sm, 0.375rem);
		background: var(--color-paper);
		color: var(--color-ink);
		font-size: 0.75rem;
		white-space: nowrap;
		pointer-events: none;
		transform: translateX(-50%);
	}
	.column:hover .tip,
	.column:hover .dot {
		display: block;
	}
	.column:hover .dot {
		box-shadow: 0 0 0 3px var(--color-accent-soft);
	}
	.axis {
		position: relative;
		height: 1.75rem;
		margin-left: 2.75rem;
		color: var(--color-lead);
		font-size: 0.8125rem;
	}
	.axis span {
		position: absolute;
		top: 0.5rem;
		white-space: nowrap;
		transform: translateX(-50%);
	}
	.axis span:first-child {
		transform: none;
	}
	.axis span:last-child {
		transform: translateX(-100%);
	}
	.daily {
		padding-bottom: 1.25rem;
		border-bottom: 1px solid var(--color-rule);
	}
	.daily summary {
		display: inline-flex;
		align-items: center;
		gap: 0.6rem;
		min-height: 2.25rem;
		color: var(--color-ink);
		font-size: 0.9375rem;
		list-style: none;
		cursor: pointer;
	}
	.daily summary::-webkit-details-marker {
		display: none;
	}
	.daily summary :global(svg) {
		transition: transform var(--dur-fast, 140ms) var(--ease-out, ease);
	}
	.daily:not([open]) summary :global(svg) {
		transform: rotate(-90deg);
	}
	table {
		width: min(100%, 24rem);
		margin-top: 0.75rem;
		border-collapse: collapse;
		font-size: 0.875rem;
		font-variant-numeric: tabular-nums;
	}
	th {
		color: var(--color-lead);
		font-weight: 600;
		text-align: left;
	}
	th,
	td {
		padding: 0.4rem 0.5rem;
		border-bottom: 1px solid var(--color-rule);
	}
	th:last-child,
	td:last-child {
		text-align: right;
	}
	.breakdowns {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 2rem;
	}
	.breakdown {
		display: grid;
		align-content: start;
		gap: 0.75rem;
		min-width: 0;
	}
	h3,
	.single-title {
		min-height: 2.25rem;
		color: var(--color-strong);
		font-size: 1.1875rem;
		font-weight: 650;
		letter-spacing: -0.02em;
	}
	.panel {
		display: grid;
		gap: 0.75rem;
	}
	.rows {
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.rows li {
		display: grid;
		grid-template-columns: 1.5rem minmax(0, 1fr) 3rem;
		align-items: center;
		gap: 0.35rem 0.85rem;
		padding: 0.6rem 0;
	}
	.rows li + li {
		border-top: 1px solid var(--color-rule);
	}
	.rows.bars li {
		border-top: 0;
		padding: 0.45rem 0;
	}
	.rows.bars li > :global(:first-child),
	.rows.bars .share {
		grid-row: span 2;
	}
	.name {
		overflow: hidden;
		color: var(--color-strong);
		font-size: 0.9375rem;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.share {
		color: var(--color-strong);
		text-align: right;
		font-size: 0.9375rem;
		font-variant-numeric: tabular-nums;
	}
	.meter {
		grid-column: 2 / 3;
		display: block;
		height: 0.5rem;
		overflow: hidden;
		border-radius: var(--radius-pill, 999px);
		background: var(--color-selected);
	}
	.meter span {
		display: block;
		height: 100%;
		border-radius: inherit;
		background: var(--color-strong);
	}
	.all {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		justify-self: start;
		min-height: 2.25rem;
		padding: 0;
		border: 0;
		background: none;
		color: var(--color-strong);
		font: inherit;
		font-size: 0.9375rem;
		font-weight: 600;
		cursor: pointer;
	}
	.all:hover {
		text-decoration: underline;
		text-underline-offset: 3px;
	}
	.none,
	.note {
		color: var(--color-lead);
		font-size: 0.875rem;
	}
	.as-of {
		display: flex;
		align-items: flex-start;
		gap: 0.6rem;
		color: var(--color-lead);
		font-size: 0.875rem;
	}
	.as-of :global(svg) {
		margin-top: 0.1rem;
	}
	.sep {
		margin: 0 0.6rem;
	}
	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
	/* Two columns with the device tabs across the bottom, then three side by side. */
	@container (min-width: 38rem) {
		.breakdowns {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
		.breakdown:nth-child(2) {
			grid-column: 1 / -1;
			grid-row: 2;
		}
	}
	@container (min-width: 60rem) {
		.breakdown:nth-child(2) {
			grid-column: auto;
			grid-row: auto;
		}
		.breakdowns {
			grid-template-columns: repeat(3, minmax(0, 1fr));
			gap: 0;
		}
		.breakdown {
			padding: 0 2rem;
		}
		.breakdown:first-child {
			padding-left: 0;
		}
		.breakdown:last-child {
			padding-right: 0;
		}
		.breakdown + .breakdown {
			border-left: 1px solid var(--color-rule);
		}
	}
	@container (max-width: 30rem) {
		.stats div {
			padding-right: 1.75rem;
		}
		.stats div + div {
			padding-left: 1.75rem;
		}
		.stats dd {
			font-size: 2rem;
		}
	}
</style>
