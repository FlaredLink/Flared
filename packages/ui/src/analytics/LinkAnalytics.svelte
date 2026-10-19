<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import EmptyState from '../empty/EmptyState.svelte';
	import Glyph from '../icons/Glyph.svelte';
	import SegmentedControl from '../molecules/SegmentedControl.svelte';
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
	// The range ends today (UTC), which is still counting; its bar is striped.
	const today = $derived(analytics.asOf.slice(0, 10));

	// Up to four day labels under their bars, always with the first and the last day. The first
	// and last align with the plot's edges, so they cannot overflow it.
	const labels = $derived.by(() => {
		const count = analytics.days.length;
		const last = count - 1;
		const indexes = [0, 1, 2, 3].map((step) => Math.round((step * last) / 3));
		return [...new Set(indexes)].map((index) => ({
			day: analytics.days[index].day,
			left: index === 0 ? 0 : index === last ? 100 : ((index + 0.5) / count) * 100
		}));
	});

	const countries = $derived(analytics.countries.filter((row) => row.value !== 'unknown').length);
	// Shares and the top site come from the breakdowns; null when there is nothing to show.
	const phoneShare = $derived.by(() => {
		const recorded = sum(analytics.devices);
		const phones = analytics.devices.find((row) => row.value === 'mobile')?.clicks ?? 0;
		return recorded === 0 ? null : percent((phones / recorded) * 100);
	});
	const topReferrer = $derived.by(() => {
		const row = analytics.referrers.find((item) => item.value !== 'unknown');
		return row ? referrer(row.value) : null;
	});

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
		// A short tab label, so three tabs fit in one of three columns.
		technology.map((item) => ({ value: item.id, label: item.id === 'systems' ? 'OS' : item.title }))
	);
	let technologyTab = $state('devices');
	let dailyView = $state('chart');
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

{#snippet rows(breakdown: Breakdown)}
	{#if breakdown.rows.length > 0}
		{@const open = expanded[breakdown.id] ?? false}
		<ol class="rows" id="{id}-{breakdown.id}-rows">
			{#each open ? breakdown.rows : breakdown.rows.slice(0, preview) as row (row.value)}
				{@const value = share(breakdown.rows, row.clicks)}
				<li>
					<span class="fill" style:width={`${value}%`} aria-hidden="true"></span>
					<DimensionIcon kind={breakdown.kind} value={row.value} {iconHref} />
					<span class="name">{breakdown.name(row.value)}</span>
					<span class="share" title={clickCount(row.clicks)}
						>{percent(value)}<span class="visually-hidden">, {clickCount(row.clicks)}</span></span
					>
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

{#snippet kpi(label: string, value: string | null)}
	<div class="kpi">
		<dt>{label}</dt>
		<dd>
			{#if value === null}<span aria-hidden="true">–</span><span class="visually-hidden">None</span
				>{:else}{value}{/if}
		</dd>
	</div>
{/snippet}

<section class="analytics" aria-labelledby="{id}-heading">
	<div class="head">
		<div class="titles">
			<h2 id="{id}-heading">Clicks</h2>
			<p class="dates">{formatDay(analytics.from)} – {formatDay(analytics.to)} · UTC</p>
		</div>
		{#if ranges.length > 0}
			<SegmentedControl
				options={ranges.map((range) => ({ value: range.href, label: range.label }))}
				value={currentRange}
				name="{id}-range"
				label="Date range"
				onchange={chooseRange}
			/>
		{/if}
	</div>

	<dl class="kpis">
		{@render kpi('Clicks', numbers.format(analytics.total))}
		{@render kpi(countries === 1 ? 'Country' : 'Countries', numbers.format(countries))}
		{@render kpi('On phones', phoneShare)}
		{@render kpi('Top referrer', topReferrer)}
	</dl>
	<p class="as-of">
		<Glyph name="refresh" size={16} />
		<span
			>Updated {time.format(new Date(analytics.asOf))} UTC. New clicks can take up to five minutes to
			appear.<span class="sep" aria-hidden="true">·</span>Link previews and known bots are not
			counted.</span
		>
	</p>

	{#if analytics.total === 0}
		<EmptyState title="No clicks in this range yet" icon="chartLine">
			Open the short link in a browser; the click shows here within a few minutes.
		</EmptyState>
	{:else}
		<section class="card daily" aria-labelledby="{id}-daily">
			<div class="daily-head">
				<h3 id="{id}-daily">Clicks per day</h3>
				<SegmentedControl
					options={[
						{ value: 'chart', label: 'Chart', icon: 'chart' },
						{ value: 'table', label: 'Table', icon: 'list' }
					]}
					bind:value={dailyView}
					name="{id}-daily-view"
					label="Show clicks per day as"
				/>
			</div>
			{#if dailyView === 'chart'}
				<figure class="chart">
					<figcaption class="visually-hidden">Clicks over time</figcaption>
					<div
						class="plot"
						role="img"
						aria-label={`Daily clicks from ${formatDay(analytics.from)} to ${formatDay(analytics.to)}. Highest day: ${numbers.format(peak)}.`}
					>
						<!-- One bar per day: daily bars keep a sparse count from looking like a trend. -->
						{#each analytics.days as day (day.day)}
							<div class="column" class:today={day.day === today}>
								<span
									class="day-bar"
									style:height={`${peak === 0 ? 0 : (day.clicks / peak) * 100}%`}
									aria-hidden="true"
								></span>
								<span class="tip" aria-hidden="true"
									>{formatDay(day.day)}{day.day === today ? ' (today so far)' : ''}: {numbers.format(
										day.clicks
									)}</span
								>
							</div>
						{/each}
					</div>
					<div class="axis" aria-hidden="true">
						{#each labels as label (label.day)}
							<span style:left={`${label.left}%`}>{formatDay(label.day)}</span>
						{/each}
					</div>
				</figure>
			{:else}
				<!-- Same height as the chart, so the page below does not move when the view changes.
				     A keyboard reaches the region to scroll it, so it takes focus. -->
				<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
				<div class="table-scroll" role="region" aria-labelledby="{id}-daily" tabindex="0">
					<table>
						<thead><tr><th scope="col">Day (UTC)</th><th scope="col">Clicks</th></tr></thead>
						<tbody>
							{#each analytics.days as day (day.day)}
								<tr><td>{formatDay(day.day)}</td><td>{numbers.format(day.clicks)}</td></tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</section>

		<div class="breakdowns">
			<section class="card breakdown" aria-labelledby="{id}-countries">
				<h3 id="{id}-countries">Countries</h3>
				{@render rows(countryBreakdown)}
			</section>
			<section class="card breakdown" aria-labelledby="{id}-technology">
				<h3 id="{id}-technology" class:visually-hidden={technologyTabs.length > 1}>
					{technologyTabs.length > 1 ? 'Devices and software' : 'Devices'}
				</h3>
				{#if technologyTabs.length > 1}
					<div class="tech-tabs">
						<Tabs
							items={technologyTabs}
							bind:value={technologyTab}
							label="Devices and software"
							idPrefix="{id}-tech"
							size="sm"
							variant="pill"
						/>
					</div>
					<div
						role="tabpanel"
						id={tabPanelId(`${id}-tech`, shownTechnology.id)}
						aria-labelledby={tabId(`${id}-tech`, shownTechnology.id)}
						class="panel"
					>
						{@render rows(shownTechnology)}
					</div>
				{:else}
					{@render rows(shownTechnology)}
				{/if}
			</section>
			<section class="card breakdown" aria-labelledby="{id}-referrers">
				<h3 id="{id}-referrers">Referrers</h3>
				{@render rows(referrerBreakdown)}
			</section>
		</div>
	{/if}
</section>

<style>
	.analytics {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 1rem;
		container-type: inline-size;
	}
	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
	}
	.titles {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.25rem 0.75rem;
	}
	h2 {
		color: var(--color-strong);
		font-size: 1.0625rem;
		font-weight: 600;
		letter-spacing: -0.01em;
	}
	.dates {
		color: var(--color-subtle);
		font-size: 0.8125rem;
		white-space: nowrap;
	}
	.kpis {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.625rem;
		margin: 0;
	}
	.kpi {
		display: grid;
		align-content: start;
		gap: 0.25rem;
		min-width: 0;
		padding: 0.75rem 0.875rem;
		border-radius: 0.75rem;
		background: var(--color-surface);
		box-shadow: var(--shadow-ring);
	}
	dt {
		color: var(--color-subtle);
		font-size: 0.75rem;
	}
	dd {
		margin: 0;
		overflow: hidden;
		color: var(--color-strong);
		font-size: 1.375rem;
		font-weight: 600;
		letter-spacing: -0.02em;
		line-height: 1.25;
		font-variant-numeric: tabular-nums;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.as-of {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
		color: var(--color-subtle);
		font-size: 0.8125rem;
	}
	.as-of :global(svg) {
		flex: none;
		margin-top: 0.125rem;
	}
	.sep {
		margin: 0 0.5rem;
	}
	.card {
		display: grid;
		align-content: start;
		gap: 0.75rem;
		min-width: 0;
		padding: 0.875rem;
		border-radius: 0.75rem;
		background: var(--color-surface);
		box-shadow: var(--shadow-ring);
	}
	.daily-head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
	}
	h3 {
		color: var(--color-strong);
		font-size: 0.9375rem;
		font-weight: 600;
	}
	.chart {
		margin: 0;
	}
	/* One column per day, no grid: ink bars at 16%, solid under the pointer, today striped. */
	.plot {
		display: flex;
		align-items: flex-end;
		gap: 2px;
		height: 7.5rem;
	}
	.column {
		position: relative;
		display: flex;
		flex: 1;
		align-items: flex-end;
		justify-content: center;
		min-width: 0;
		height: 100%;
	}
	.day-bar {
		width: 100%;
		max-width: 2.5rem;
		min-height: 2px;
		border-radius: 3px 3px 1px 1px;
		background: color-mix(in srgb, var(--color-strong) 16%, transparent);
		transition: background var(--dur-fast) var(--ease-out);
	}
	.column:hover .day-bar {
		background: var(--color-strong);
	}
	.today .day-bar,
	.today:hover .day-bar {
		background: repeating-linear-gradient(135deg, var(--color-faint) 0 3px, transparent 3px 6px);
		box-shadow: inset 0 0 0 1px var(--color-faint);
	}
	.tip {
		position: absolute;
		bottom: calc(100% + 0.25rem);
		left: 50%;
		z-index: 1;
		display: none;
		padding: 0.25rem 0.5rem;
		border-radius: var(--radius-sm, 0.375rem);
		background: var(--color-tooltip);
		color: var(--color-on-tooltip);
		font-size: 0.75rem;
		white-space: nowrap;
		pointer-events: none;
		transform: translateX(-50%);
	}
	.column:first-child .tip {
		left: 0;
		transform: none;
	}
	.column:last-child .tip {
		right: 0;
		left: auto;
		transform: none;
	}
	.column:hover .tip {
		display: block;
	}
	.axis {
		position: relative;
		height: 1.5rem;
		color: var(--color-subtle);
		font-size: 0.75rem;
	}
	.axis span {
		position: absolute;
		top: 0.375rem;
		white-space: nowrap;
		transform: translateX(-50%);
	}
	.axis span:first-child {
		transform: none;
	}
	.axis span:last-child {
		transform: translateX(-100%);
	}
	/* The chart's plot and axis rows together. */
	.table-scroll {
		height: 9rem;
		overflow-y: auto;
		overscroll-behavior: contain;
		border-radius: var(--radius-sm, 0.375rem);
		box-shadow: var(--shadow-ring);
	}
	.table-scroll:focus-visible {
		outline: 2px solid var(--color-focus);
		outline-offset: 2px;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.875rem;
		font-variant-numeric: tabular-nums;
	}
	th {
		position: sticky;
		top: 0;
		background: var(--color-surface);
		color: var(--color-subtle);
		font-weight: 500;
		text-align: left;
		box-shadow: inset 0 -1px var(--color-rule-soft);
	}
	th,
	td {
		padding: 0.4rem 0.75rem;
	}
	tbody tr + tr td {
		border-top: 1px solid var(--color-rule-soft);
	}
	th:last-child,
	td:last-child {
		text-align: right;
	}
	.breakdowns {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 0.625rem;
	}
	.breakdown {
		gap: 0.375rem;
		padding-inline: 0.375rem;
	}
	.breakdown h3,
	.tech-tabs {
		margin: 0 0.5rem 0.25rem;
	}
	.panel {
		display: grid;
		gap: 0.375rem;
	}
	.rows {
		display: grid;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	/* The share is a grey bar behind the row. */
	.rows li {
		position: relative;
		display: grid;
		grid-template-columns: 1.25rem minmax(0, 1fr) auto;
		align-items: center;
		gap: 0.625rem;
		min-height: 2.25rem;
		padding: 0 0.625rem;
		isolation: isolate;
	}
	.fill {
		position: absolute;
		inset-block: 2px;
		left: 0;
		z-index: -1;
		border-radius: 0.5rem;
		background: var(--color-surface-2);
	}
	.name {
		overflow: hidden;
		color: var(--color-strong);
		font-size: 0.875rem;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.share {
		color: var(--color-muted);
		text-align: right;
		font-size: 0.875rem;
		font-variant-numeric: tabular-nums;
	}
	.all {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		justify-self: start;
		min-height: 2.25rem;
		padding: 0 0.625rem;
		border: 0;
		border-radius: var(--radius-control, 0.5rem);
		background: none;
		color: var(--color-strong);
		font: inherit;
		font-size: 0.8125rem;
		font-weight: 500;
		cursor: pointer;
	}
	.all:hover {
		background: var(--color-surface-2);
	}
	@media (pointer: coarse) {
		.all {
			min-height: 2.75rem;
		}
	}
	.none,
	.note {
		padding: 0 0.625rem 0.375rem;
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
	/* Four KPIs in a row; two breakdown columns with the device card across the bottom, then
	   three side by side. */
	@container (min-width: 38rem) {
		.kpis {
			grid-template-columns: repeat(4, minmax(0, 1fr));
		}
		.plot {
			gap: 4px;
			height: 9.375rem;
		}
		.table-scroll {
			height: 10.875rem;
		}
		.breakdowns {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
		.breakdown:nth-child(2) {
			grid-column: 1 / -1;
			grid-row: 2;
		}
	}
	@container (min-width: 60rem) {
		.breakdowns {
			grid-template-columns: repeat(3, minmax(0, 1fr));
		}
		.breakdown:nth-child(2) {
			grid-column: auto;
			grid-row: auto;
		}
	}
</style>
