<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import type { Snippet } from 'svelte';

	let { children }: { children: Snippet } = $props();
</script>

<kbd>{@render children()}</kbd>

<style>
	kbd {
		display: inline-grid;
		place-items: center;
		min-width: 1.5rem;
		height: 1.5rem;
		padding: 0 0.4rem;
		border: 1px solid var(--color-rule);
		border-bottom-width: 2px;
		border-radius: var(--radius-sm, 0.375rem);
		background: var(--color-paper);
		color: var(--color-ink);
		font-family: var(--font-body);
		font-size: 0.75rem;
		font-weight: 600;
		line-height: 1;
	}
</style>
