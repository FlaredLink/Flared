<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import type { Usage } from '@flared/contracts/analytics';
	import Glyph, { type GlyphName } from '../icons/Glyph.svelte';
	import Meter from '../atoms/Meter.svelte';

	// A null heading leaves the title to the surrounding card; the section keeps its name.
	let { usage, heading = 'Usage' }: { usage: Usage; heading?: string | null } = $props();

	const numbers = new Intl.NumberFormat();
	const dates = new Intl.DateTimeFormat(undefined, {
		dateStyle: 'medium',
		timeStyle: 'short',
		timeZone: 'UTC'
	});
	const months = new Intl.DateTimeFormat(undefined, {
		month: 'long',
		year: 'numeric',
		timeZone: 'UTC'
	});
	const period = $derived(months.format(new Date(`${usage.month}-01T00:00:00Z`)));

	const meters = $derived<
		{ id: string; label: string; icon: GlyphName; used: number; limit: number }[]
	>([
		{
			id: 'links',
			label: 'active links',
			icon: 'link',
			used: usage.links.used,
			limit: usage.links.limit
		},
		{
			id: 'clicks',
			label: 'recorded clicks this month',
			icon: 'chart',
			used: usage.clicks,
			limit: usage.clickLimit
		},
		{
			id: 'domains',
			label: 'custom domains',
			icon: 'globe',
			used: usage.domains.used,
			limit: usage.domains.limit
		}
	]);
</script>

<section
	class="usage-meters"
	aria-labelledby={heading ? 'usage-meters-heading' : undefined}
	aria-label={heading ? undefined : 'Usage'}
>
	{#if heading}<h2 id="usage-meters-heading">{heading}</h2>{/if}
	<ul>
		{#each meters as meter (meter.id)}
			{@const ratio = meter.limit > 0 ? meter.used / meter.limit : 0}
			<li class:near={ratio >= 0.8 && ratio < 1} class:full={meter.limit > 0 && ratio >= 1}>
				<span class="icon"><Glyph name={meter.icon} size={28} /></span>
				<span class="body">
					<span class="count">{numbers.format(meter.used)} / {numbers.format(meter.limit)}</span>
					<Meter
						value={meter.used}
						max={meter.limit}
						label="{numbers.format(meter.used)} of {numbers.format(meter.limit)} {meter.label}"
					/>
					<span class="label">{meter.label}</span>
				</span>
			</li>
		{/each}
	</ul>
	{#if usage.unrecordedClicks > 0}
		<p class="note">
			{numbers.format(usage.unrecordedClicks)} clicks{usage.unrecordedSince
				? ` since ${dates.format(new Date(usage.unrecordedSince))} UTC`
				: ''} are not recorded. Your links keep redirecting.
		</p>
	{/if}
	<div class="foot">
		<p class="note">{numbers.format(usage.retentionDays)} days of analytics history.</p>
		<p class="note">Usage period: {period} (UTC)</p>
	</div>
</section>

<style>
	.usage-meters {
		display: grid;
		gap: 1rem;
		container-type: inline-size;
	}
	h2 {
		font-size: 1.125rem;
		font-weight: 700;
		letter-spacing: -0.02em;
	}
	ul {
		display: grid;
		gap: 1.25rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	li {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		align-items: start;
		gap: 1rem;
		min-width: 0;
	}
	.icon {
		display: grid;
		margin-top: 0.1rem;
		color: var(--color-ink);
	}
	.body {
		display: grid;
		gap: 0.45rem;
		min-width: 0;
	}
	.count {
		color: var(--color-strong);
		font-size: 1.0625rem;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}
	.label {
		color: var(--color-lead);
		font-size: 0.875rem;
	}
	.near .count {
		color: var(--color-warning);
	}
	.full .count {
		color: var(--color-danger);
	}
	.foot {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		gap: 0.25rem 1rem;
		padding-top: 0.9rem;
		border-top: 1px solid var(--color-rule);
	}
	.note {
		color: var(--color-lead);
		font-size: 0.875rem;
	}
	/* Side by side once each meter has room for its count. */
	@container (min-width: 36rem) {
		ul {
			grid-template-columns: repeat(3, minmax(0, 1fr));
			gap: 0;
		}
		li {
			padding-inline: 1.5rem;
		}
		li:first-child {
			padding-left: 0;
		}
		li:last-child {
			padding-right: 0;
		}
		li + li {
			border-left: 1px solid var(--color-rule);
		}
	}
</style>
