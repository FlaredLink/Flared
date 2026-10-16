<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	// A usage bar: coral normally (ink with tone 'ink'), amber from 80%, red at the limit.
	let {
		value,
		max,
		label,
		tone = 'accent'
	}: { value: number; max: number; label: string; tone?: 'accent' | 'ink' } = $props();
	const ratio = $derived(max > 0 ? Math.min(value / max, 1) : 0);
	const level = $derived(ratio >= 1 ? 'full' : ratio >= 0.8 ? 'near' : 'normal');
</script>

<span
	class="meter {level} {tone}"
	role="meter"
	aria-label={label}
	aria-valuemin={0}
	aria-valuemax={max}
	aria-valuenow={Math.min(value, max)}
	><span class="fill" style:width="{Math.max(ratio * 100, value > 0 ? 2 : 0)}%"></span></span
>

<style>
	.meter {
		display: block;
		height: 0.375rem;
		overflow: hidden;
		border-radius: var(--radius-pill, 999px);
		background: var(--color-selected);
	}
	.fill {
		display: block;
		height: 100%;
		border-radius: inherit;
		background: var(--color-accent);
	}
	.ink.normal .fill {
		background: var(--color-strong);
	}
	.near .fill {
		background: var(--color-warning);
	}
	.full .fill {
		background: var(--color-danger);
	}
</style>
