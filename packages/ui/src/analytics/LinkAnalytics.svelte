<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import EmptyState from '../empty/EmptyState.svelte';
	import DimensionIcon, { phosphor, type IconKind } from './DimensionIcon.svelte';
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
		// Address of a site's icon on the app's origin. Without it, referrers show a letter.
		iconHref?: (hostname: string) => string;
	}

	let { analytics, ranges = [], iconHref }: Props = $props();
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

	// The plot is 100 units high and one unit wide per day; the SVG stretches to the box.
	const points = $derived.by(() => {
		const values = analytics.days.map((day) => 100 - (day.clicks / scale) * 100);
		const ys = values.length === 1 ? [values[0], values[0]] : values;
		return ys.map((y, x) => `${x},${y.toFixed(2)}`);
	});
	const width = $derived(Math.max(1, points.length - 1));
	const line = $derived(`M${points.join(' L')}`);
	const area = $derived(`M0,100 L${points.join(' L')} L${width},100 Z`);
	// Up to five day labels, evenly spaced, always with the first and the last day.
	const labels = $derived.by(() => {
		const last = analytics.days.length - 1;
		const indexes = [0, 1, 2, 3, 4].map((step) => Math.round((step * last) / 4));
		return [...new Set(indexes)].map((index) => ({
			day: analytics.days[index].day,
			left: last === 0 ? 0 : (index / last) * 100
		}));
	});

	const stats = $derived.by(() => {
		const topCountry = analytics.countries.find((row) => row.value !== 'unknown')?.value;
		const device = analytics.devices.find((row) => row.value !== 'unknown')?.value;
		return [
			{ label: 'Total clicks', value: numbers.format(analytics.total), icon: phosphor.direct },
			{ label: 'Top country', value: topCountry ? country(topCountry) : '–', icon: phosphor.globe },
			{
				label: 'Top device',
				value: device ? (deviceNames[device] ?? device) : '–',
				icon: (device && phosphor[device]) || phosphor.unknown
			}
		];
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

	const breakdowns = $derived.by(() => {
		const list: Breakdown[] = [
			{
				id: 'countries',
				title: 'Top countries',
				kind: 'country',
				rows: analytics.countries,
				name: country
			},
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
		list.push({
			id: 'referrers',
			title: 'Referrers',
			kind: 'referrer',
			rows: analytics.referrers,
			name: referrer
		});
		return list;
	});

	function share(rows: DimensionClicks[], clicks: number): number {
		const total = sum(rows);
		return total === 0 ? 0 : (clicks / total) * 100;
	}

	function percent(value: number): string {
		return value > 0 && value < 1 ? '<1%' : `${Math.round(value)}%`;
	}
</script>

<section class="analytics" aria-labelledby="analytics-heading">
	<div class="head">
		<div>
			<h2 id="analytics-heading">Clicks</h2>
			<p class="range">{formatDay(analytics.from)} – {formatDay(analytics.to)} (UTC)</p>
		</div>
		{#if ranges.length > 0}
			<nav class="ranges" aria-label="Date range">
				{#each ranges as range (range.href)}
					<a href={range.href} aria-current={range.current ? 'page' : undefined}>{range.label}</a>
				{/each}
			</nav>
		{/if}
	</div>

	<dl class="overview">
		{#each stats as stat (stat.label)}
			<div class="stat">
				<span class="stat-icon" aria-hidden="true">
					<svg viewBox="0 0 256 256" width="20" height="20" fill="currentColor"
						><path d={stat.icon} /></svg
					>
				</span>
				<dt>{stat.label}</dt>
				<dd>{stat.value}</dd>
			</div>
		{/each}
	</dl>

	{#if analytics.total === 0}
		<EmptyState>
			No clicks in this range yet. Open the short link in a browser; the click shows here within a
			few minutes.
		</EmptyState>
	{:else}
		<figure class="card chart">
			<figcaption class="card-title">Clicks over time</figcaption>
			<div
				class="plot"
				role="img"
				aria-label={`Daily clicks from ${formatDay(analytics.from)} to ${formatDay(analytics.to)}. Highest day: ${numbers.format(peak)}.`}
			>
				<span class="tick" style:top="0" aria-hidden="true">{numbers.format(scale)}</span>
				{#if scale > 1 && scale % 2 === 0}
					<span class="tick" style:top="50%" aria-hidden="true">{numbers.format(scale / 2)}</span>
				{/if}
				<span class="tick" style:top="100%" aria-hidden="true">0</span>
				<div class="area" aria-hidden="true">
					<span class="grid" style:top="0"></span>
					<span class="grid" style:top="50%"></span>
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
								<span class="dot" style:bottom={`${(day.clicks / scale) * 100}%`}></span>
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
				<section class="card breakdown {breakdown.id}" aria-labelledby={`${id}-${breakdown.id}`}>
					<h3 class="card-title" id={`${id}-${breakdown.id}`}>{breakdown.title}</h3>
					{#if breakdown.rows.length > 0}
						<ol>
							{#each breakdown.rows.slice(0, 8) as row (row.value)}
								{@const value = share(breakdown.rows, row.clicks)}
								<li>
									<DimensionIcon kind={breakdown.kind} value={row.value} {iconHref} />
									<span class="name">{breakdown.name(row.value)}</span>
									<span class="meter" aria-hidden="true"
										><span style:width={`${value}%`}></span></span
									>
									<span class="share" title={clickCount(row.clicks)}
										>{percent(value)}<span class="visually-hidden">, {clickCount(row.clicks)}</span
										></span
									>
								</li>
							{/each}
						</ol>
					{/if}
					{#if breakdown.recorded && breakdown.recorded.clicks < analytics.total}
						<p class="note">
							{breakdown.recorded.clicks === 0
								? `No ${breakdown.recorded.noun} data for these clicks yet. Recording started after them.`
								: `Based on ${numbers.format(breakdown.recorded.clicks)} of ${numbers.format(analytics.total)} clicks. Older clicks have no ${breakdown.recorded.noun} data.`}
						</p>
					{/if}
				</section>
			{/each}
		</div>
	{/if}
	<p class="as-of">
		Updated {time.format(new Date(analytics.asOf))} UTC. New clicks can take up to five minutes to appear.
		Link previews and known bots are not counted.
	</p>
</section>

<style>
	.analytics {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 1rem;
		max-width: 64rem;
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
	.range,
	.as-of,
	.note {
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
	.card,
	.stat {
		border: 1px solid var(--color-rule, #d0d5dd);
		border-radius: var(--radius-md, 10px);
		background: var(--color-surface, #fff);
	}
	.card {
		margin: 0;
		padding: 1rem 1.1rem;
	}
	.card-title {
		color: var(--color-strong, #101828);
		font-size: 0.95rem;
		font-weight: 650;
	}
	.overview {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
		gap: 0.75rem;
		margin: 0;
	}
	.stat {
		display: grid;
		grid-template-columns: auto 1fr;
		grid-template-rows: auto auto;
		align-items: center;
		gap: 0 0.85rem;
		padding: 0.9rem 1rem;
	}
	.stat-icon {
		display: inline-flex;
		grid-row: 1 / 3;
		align-items: center;
		justify-content: center;
		width: 2.5rem;
		height: 2.5rem;
		border-radius: 50%;
		background: var(--color-accent-soft, #fff4ed);
		color: var(--color-accent-ink, #c4561d);
	}
	dt {
		color: var(--color-muted, #667085);
		font-size: 0.85rem;
	}
	dd {
		margin: 0;
		color: var(--color-strong, #101828);
		font-size: 1.5rem;
		font-weight: 650;
		font-variant-numeric: tabular-nums;
		line-height: 1.2;
	}
	.plot {
		position: relative;
		height: 11rem;
		margin-top: 0.85rem;
		padding-left: 2.75rem;
	}
	.tick {
		position: absolute;
		left: 0;
		color: var(--color-muted, #667085);
		font-size: 0.75rem;
		font-variant-numeric: tabular-nums;
		line-height: 1;
		transform: translateY(-50%);
	}
	.area {
		position: relative;
		height: 100%;
		border-bottom: 1px solid var(--color-rule, #d0d5dd);
	}
	.grid {
		position: absolute;
		right: 0;
		left: 0;
		border-top: 1px dashed var(--color-rule, #d0d5dd);
	}
	.area svg {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		overflow: visible;
	}
	.fill-top {
		stop-color: var(--color-accent-ink, #c4561d);
		stop-opacity: 0.22;
	}
	.fill-bottom {
		stop-color: var(--color-accent-ink, #c4561d);
		stop-opacity: 0;
	}
	.line {
		fill: none;
		stroke: var(--color-accent-ink, #c4561d);
		stroke-width: 2;
		stroke-linejoin: round;
	}
	.columns {
		position: absolute;
		inset: 0;
		display: flex;
	}
	.column {
		position: relative;
		flex: 1;
		min-width: 0;
	}
	/* One column per day, centred on its point: the first and last columns reach half a column
	 * past the ends of the line. */
	.columns {
		margin: 0 calc(-1 * var(--half));
	}
	.dot {
		position: absolute;
		left: 50%;
		display: none;
		width: 8px;
		height: 8px;
		border: 2px solid var(--color-surface, #fff);
		border-radius: 50%;
		background: var(--color-accent-ink, #c4561d);
		transform: translate(-50%, 50%);
	}
	.tip {
		position: absolute;
		bottom: calc(100% + 0.25rem);
		left: 50%;
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
		transform: translateX(-50%);
	}
	.column:hover .tip,
	.column:hover .dot {
		display: block;
	}
	.axis {
		position: relative;
		height: 1.4rem;
		margin-left: 2.75rem;
		color: var(--color-muted, #667085);
		font-size: 0.75rem;
	}
	.axis span {
		position: absolute;
		top: 0.35rem;
		white-space: nowrap;
		transform: translateX(-50%);
	}
	.axis span:first-child {
		transform: none;
	}
	.axis span:last-child {
		transform: translateX(-100%);
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
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 22rem), 1fr));
		gap: 0.75rem;
	}
	.breakdown {
		--bar: var(--color-accent-ink, #c4561d);
		display: grid;
		align-content: start;
		gap: 0.75rem;
		container-type: inline-size;
	}
	.breakdown.devices {
		--bar: var(--color-tile-blue, #2563eb);
	}
	.breakdown.browsers {
		--bar: var(--color-tile-teal, #0f766e);
	}
	.breakdown.systems {
		--bar: var(--color-tile-violet, #6d28d9);
	}
	ol {
		display: grid;
		gap: 0.6rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	li {
		display: grid;
		grid-template-columns: 20px minmax(0, 1fr) minmax(4rem, 40%) 2.75rem;
		align-items: center;
		gap: 0.6rem;
		font-size: 0.875rem;
	}
	@container (max-width: 22rem) {
		li {
			grid-template-columns: 20px minmax(0, 1fr) 2.75rem;
		}
		.meter {
			grid-column: 2 / -1;
			grid-row: 2;
		}
	}
	.name {
		overflow: hidden;
		color: var(--color-ink, #101828);
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.share {
		color: var(--color-muted, #667085);
		font-variant-numeric: tabular-nums;
		text-align: right;
	}
	.meter {
		height: 8px;
		border-radius: 4px;
		background: var(--color-disabled, #f2f4f7);
	}
	.meter span {
		display: block;
		height: 100%;
		min-width: 2px;
		border-radius: 4px;
		background: var(--bar);
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
