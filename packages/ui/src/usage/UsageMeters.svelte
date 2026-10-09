<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import { usageLevel, type Usage } from '@flared/contracts/analytics';

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

	const meters = $derived([
		{ id: 'links', label: 'Active links', used: usage.links.used, limit: usage.links.limit },
		{ id: 'clicks', label: 'Recorded clicks', used: usage.clicks, limit: usage.clickLimit },
		{
			id: 'domains',
			label: 'Custom domains',
			used: usage.domains.used,
			limit: usage.domains.limit
		}
	]);

	// A limit of 0 shows an empty bar: the resource is turned off.
	function share(used: number, limit: number): number {
		return limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
	}
</script>

<section
	class="usage-meters"
	aria-labelledby={heading ? 'usage-meters-heading' : undefined}
	aria-label={heading ? undefined : 'Usage'}
>
	{#if heading}<h2 id="usage-meters-heading">{heading}</h2>{/if}
	<ul>
		{#each meters as meter (meter.id)}
			{@const level = usageLevel(meter.used, meter.limit)}
			<li class:near={level === 80} class:full={level === 100}>
				<span class="label" id="usage-{meter.id}">{meter.label}</span>
				<span class="count">{numbers.format(meter.used)} / {numbers.format(meter.limit)}</span>
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
		font-size: 1rem;
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
		gap: 0.35rem;
		min-width: 0;
	}
	.label {
		color: var(--color-ink, #101828);
		font-size: 0.875rem;
	}
	.count {
		color: var(--color-strong, #101828);
		font-size: 1.35rem;
		font-weight: 650;
		font-variant-numeric: tabular-nums;
		letter-spacing: -0.01em;
	}
	.bar {
		height: 0.5rem;
		margin-top: 0.4rem;
		overflow: hidden;
		border-radius: 999px;
		background: var(--color-disabled, #f2f4f7);
	}
	/* Orange in use, amber from 80%, red when full; the count above it says the same. */
	.bar span {
		display: block;
		height: 100%;
		border-radius: inherit;
		background: var(--color-button-primary, #c94b00);
	}
	.near .bar span {
		background: var(--color-warning, #b54708);
	}
	.full .bar span {
		background: var(--color-button-danger, #b42318);
	}
	.near .count {
		color: var(--color-warning, #b54708);
	}
	.full .count {
		color: var(--color-danger, #b42318);
	}
	.foot {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		gap: 0.25rem 1rem;
		padding-top: 1rem;
		border-top: 1px solid var(--color-rule, #eaecf0);
	}
	.note {
		color: var(--color-muted, #667085);
		font-size: 0.85rem;
	}
	/* Side by side once each meter has room for its count. */
	@container (min-width: 34rem) {
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
			border-left: 1px solid var(--color-rule, #eaecf0);
		}
	}
</style>
