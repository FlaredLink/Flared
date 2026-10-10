<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	// A small area chart of daily counts, oldest first. The text beside it carries the numbers.
	let { values, height = 80 }: { values: number[]; height?: number } = $props();
	const width = 300;
	const points = $derived.by(() => {
		const max = Math.max(1, ...values);
		const step = values.length > 1 ? width / (values.length - 1) : width;
		return values.map((value, index) => [index * step, height - 3 - (value / max) * (height - 6)]);
	});
	const line = $derived(points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' '));
	const area = $derived(`0,${height} ${line} ${width},${height}`);
</script>

<svg
	viewBox="0 0 {width} {height}"
	preserveAspectRatio="none"
	style:height="{height}px"
	aria-hidden="true"
>
	{#if points.length > 1}
		<polygon class="area" points={area} />
		<polyline class="line" points={line} />
	{/if}
</svg>

<style>
	svg {
		display: block;
		width: 100%;
		overflow: visible;
	}
	.area {
		fill: var(--color-chart-fill);
	}
	.line {
		fill: none;
		stroke: var(--color-accent);
		stroke-width: 2;
		stroke-linejoin: round;
		vector-effect: non-scaling-stroke;
	}
</style>
