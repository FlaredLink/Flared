<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import { usageLevel, type Usage } from '@flared/contracts/analytics';

	let { usage }: { usage: Usage } = $props();

	const numbers = new Intl.NumberFormat();
	const dates = new Intl.DateTimeFormat(undefined, {
		dateStyle: 'medium',
		timeStyle: 'short',
		timeZone: 'UTC'
	});

	const meters = $derived([
		{ id: 'links', label: 'Active links', used: usage.links.used, limit: usage.links.limit },
		{
			id: 'domains',
			label: 'Custom domains',
			used: usage.domains.used,
			limit: usage.domains.limit
		},
		{
			id: 'clicks',
			label: `Recorded clicks in ${usage.month} (UTC)`,
			used: usage.clicks,
			limit: usage.clickLimit
		}
	]);

	// A limit of 0 shows an empty bar: the resource is turned off.
	function share(used: number, limit: number): number {
		return limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
	}
</script>

<section class="usage-meters" aria-labelledby="usage-meters-heading">
	<h2 id="usage-meters-heading">Usage</h2>
	<ul>
		{#each meters as meter (meter.id)}
			{@const level = usageLevel(meter.used, meter.limit)}
			<li class:near={level === 80} class:full={level === 100}>
				<div class="meter-head">
					<span id="usage-{meter.id}">{meter.label}</span>
					<span>{numbers.format(meter.used)} of {numbers.format(meter.limit)}</span>
				</div>
				<div
					class="bar"
					role="meter"
					aria-labelledby="usage-{meter.id}"
					aria-valuemin={0}
					aria-valuemax={meter.limit}
					aria-valuenow={Math.min(meter.used, meter.limit)}
					aria-valuetext="{numbers.format(meter.used)} of {numbers.format(meter.limit)}"
				>
					<span style:width="{share(meter.used, meter.limit)}%"></span>
				</div>
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
	<p class="note">Analytics history: {numbers.format(usage.retentionDays)} days.</p>
</section>

<style>
	.usage-meters {
		display: grid;
		gap: 0.75rem;
		max-width: 44rem;
	}
	h2 {
		font-size: 1rem;
	}
	ul {
		display: grid;
		gap: 1rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.meter-head {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		gap: 0.25rem 1rem;
		color: var(--color-ink, #101828);
		font-size: 0.9rem;
	}
	.meter-head span:last-child {
		color: var(--color-muted, #667085);
		font-variant-numeric: tabular-nums;
	}
	.bar {
		height: 0.5rem;
		margin-top: 0.4rem;
		overflow: hidden;
		border-radius: 999px;
		background: var(--color-surface, #f2f4f7);
		box-shadow: inset 0 0 0 1px var(--color-rule, #d0d5dd);
	}
	.bar span {
		display: block;
		height: 100%;
		border-radius: inherit;
		background: var(--color-strong, #101828);
	}
	.near .bar span,
	.full .bar span {
		background: var(--color-accent-ink, #b42318);
	}
	.full .meter-head span:last-child {
		color: var(--color-accent-ink, #b42318);
		font-weight: 600;
	}
	.note {
		color: var(--color-muted, #667085);
		font-size: 0.85rem;
	}
</style>
