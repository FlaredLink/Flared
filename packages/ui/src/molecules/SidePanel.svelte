<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import IconButton from '../atoms/IconButton.svelte';

	interface Props {
		// The small uppercase label at the top, such as "Link details".
		label: string;
		id: string;
		onclose?: () => void;
		children: Snippet;
	}
	let { label, id, onclose, children }: Props = $props();
	let panel = $state<HTMLElement>();

	// On narrow screens the panel covers the page, so Escape closes it there too.
	function keydown(event: KeyboardEvent) {
		if (event.key === 'Escape' && onclose && panel?.contains(document.activeElement)) onclose();
	}
</script>

<svelte:window onkeydown={keydown} />

<aside class="side-panel" aria-labelledby={id} bind:this={panel}>
	<div class="head">
		<p class="label" {id}>{label}</p>
		{#if onclose}<IconButton
				icon="x"
				label="Close {label.toLocaleLowerCase()}"
				size="sm"
				onclick={onclose}
			/>{/if}
	</div>
	<div class="body">{@render children()}</div>
</aside>

<style>
	.side-panel {
		position: sticky;
		top: 1.5rem;
		display: grid;
		align-content: start;
		gap: 0.75rem;
		max-height: calc(100svh - 3rem);
		overflow-y: auto;
		padding: 1.25rem 1.5rem 1.5rem;
		border: 1px solid var(--color-rule);
		border-radius: var(--radius-lg, 0.875rem);
		background: var(--color-paper);
		box-shadow: var(--shadow-card);
	}
	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		margin-right: -0.5rem;
	}
	.label {
		color: var(--color-lead);
		font-size: 0.8125rem;
		font-weight: 600;
		letter-spacing: 0.12em;
		text-transform: uppercase;
	}
	.body {
		display: grid;
		gap: 1.25rem;
		min-width: 0;
	}
	/* Without room for two columns, the panel slides over the page from the right. */
	@media (max-width: 74.99rem) {
		.side-panel {
			position: fixed;
			top: 0.75rem;
			right: 0.75rem;
			bottom: 0.75rem;
			z-index: 40;
			width: min(26rem, 100% - 1.5rem);
			max-height: none;
			box-shadow: var(--shadow-float);
		}
	}
</style>
