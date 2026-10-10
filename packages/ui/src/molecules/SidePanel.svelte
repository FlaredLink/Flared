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
	/* A full-height sidebar on the right edge of the window. The head stays in place and the
	   body scrolls on its own. */
	.side-panel {
		position: fixed;
		top: 0;
		right: 0;
		bottom: 0;
		z-index: 40;
		display: flex;
		flex-direction: column;
		width: min(var(--side-panel-width), 100%);
		border-left: 1px solid var(--color-rule);
		background: var(--color-paper);
		animation: slide-in 220ms var(--ease-out, ease-out);
	}
	.head {
		display: flex;
		flex: none;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		min-height: 4rem;
		padding: 0.75rem 1rem 0.75rem 1.5rem;
		border-bottom: 1px solid var(--color-rule);
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
		flex: 1;
		align-content: start;
		gap: 1.25rem;
		min-width: 0;
		padding: 1.5rem 1.5rem 2rem;
		overflow-y: auto;
		overscroll-behavior: contain;
	}
	@keyframes slide-in {
		from {
			transform: translateX(1.5rem);
			opacity: 0;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.side-panel {
			animation: none;
		}
	}
	/* Wide windows keep the page beside the sidebar. */
	@media (min-width: 75rem) {
		:global(body:has(.side-panel)) {
			padding-right: var(--side-panel-width);
		}
	}
	/* Narrow windows show the sidebar over the page. */
	@media (max-width: 74.99rem) {
		.side-panel {
			box-shadow: var(--shadow-float);
		}
	}
</style>
