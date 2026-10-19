<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	// Bars of daily counts, oldest first. The text beside it carries the numbers. With today, the
	// last bar is today and shows in ink.
	let { values, today = false }: { values: number[]; today?: boolean } = $props();
	const max = $derived(Math.max(1, ...values));
</script>

<span class="sparkline" aria-hidden="true">
	{#each values as value, index (index)}
		<span
			class:today={today && index === values.length - 1}
			style:height="{Math.max(0, (value / max) * 100)}%"
		></span>
	{/each}
</span>

<style>
	/* The caller sets the size; bars share the width and grow from the bottom. */
	.sparkline {
		display: flex;
		align-items: flex-end;
		gap: var(--sparkline-gap, 1px);
		width: 100%;
		height: 100%;
	}
	span span {
		flex: 1;
		min-width: 0;
		min-height: 2px;
		border-radius: var(--sparkline-radius, 1px);
		background: var(--sparkline-color, var(--color-surface-3));
	}
	.today {
		background: var(--color-strong);
	}
</style>
