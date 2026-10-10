<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import type { Snippet } from 'svelte';

	// The page content, with a details panel beside it while one is open.
	let { children, panel }: { children: Snippet; panel?: Snippet } = $props();
</script>

<div class="split" class:open={panel}>
	<div class="main">{@render children()}</div>
	{#if panel}{@render panel()}{/if}
</div>

<style>
	.split {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 2rem;
		align-items: start;
	}
	.main {
		min-width: 0;
	}
	@media (min-width: 75rem) {
		.open {
			grid-template-columns: minmax(0, 1fr) minmax(22rem, 26rem);
		}
	}
</style>
