<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import type { Snippet } from 'svelte';

	// The page content, with a details panel beside it while one is open. Pass open when the
	// panel snippet can render nothing, so no empty column is kept for it.
	let {
		children,
		panel,
		open = Boolean(panel)
	}: { children: Snippet; panel?: Snippet; open?: boolean } = $props();
</script>

<div class="split" class:open>
	<div class="main">{@render children()}</div>
	{#if panel && open}{@render panel()}{/if}
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
