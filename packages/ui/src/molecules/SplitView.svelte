<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import type { Snippet } from 'svelte';

	// The page content, with a SidePanel on the right while one is open. Pass open when the
	// panel snippet can render nothing.
	let {
		children,
		panel,
		open = Boolean(panel)
	}: { children: Snippet; panel?: Snippet; open?: boolean } = $props();
</script>

<div class="split">
	<div class="main">{@render children()}</div>
	{#if panel && open}{@render panel()}{/if}
</div>

<style>
	.main {
		min-width: 0;
	}
</style>
