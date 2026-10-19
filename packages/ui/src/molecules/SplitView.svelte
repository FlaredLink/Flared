<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import type { Snippet } from 'svelte';

	// The page content, with a SidePanel while one is open. Pass open when the panel snippet can
	// render nothing. With dockAt, the panel becomes a column beside the content once the view is
	// at least that many pixels wide; docked tells the page, which passes it to the SidePanel.
	let {
		children,
		panel,
		open = Boolean(panel),
		dockAt,
		docked = $bindable(false)
	}: {
		children: Snippet;
		panel?: Snippet;
		open?: boolean;
		dockAt?: number;
		docked?: boolean;
	} = $props();
	let width = $state(0);
	$effect(() => {
		docked = dockAt !== undefined && width >= dockAt;
	});
</script>

<div class="split" class:docked={docked && open} bind:clientWidth={width}>
	<div class="main">{@render children()}</div>
	{#if panel && open}{@render panel()}{/if}
</div>

<style>
	.main {
		min-width: 0;
	}
	.docked {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 18.75rem;
		align-items: start;
		gap: 1rem;
	}
</style>
