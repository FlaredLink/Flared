<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { prefersReducedMotion } from 'svelte/motion';
	import { cubicIn } from 'svelte/easing';
	import { fly } from 'svelte/transition';
	import IconButton from '../atoms/IconButton.svelte';

	interface Props {
		// The small uppercase label at the top, such as "Link details".
		label: string;
		id: string;
		onclose?: () => void;
		// A column beside the page content under the page bar, from SplitView, in place of a
		// panel over the page.
		docked?: boolean;
		children: Snippet;
	}
	let { label, id, onclose, docked = false, children }: Props = $props();
	let panel = $state<HTMLElement>();

	// On narrow screens the panel covers the page, so Escape closes it there too.
	function keydown(event: KeyboardEvent) {
		if (event.key === 'Escape' && onclose && panel?.contains(document.activeElement)) onclose();
	}
</script>

<svelte:window onkeydown={keydown} />

<!-- Closing slides the panel out in about 70 percent of --dur-base. Svelte transitions do not
     read CSS variables or the CSS reduced-motion rule, so both are handled here. -->
<aside
	class="side-panel"
	class:docked
	aria-labelledby={id}
	bind:this={panel}
	out:fly={{ x: 24, duration: prefersReducedMotion.current || docked ? 0 : 154, easing: cubicIn }}
>
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
		/* Over the page, so it lifts off it. */
		box-shadow: var(--shadow-lift);
		animation: slide-in var(--dur-base) var(--ease-out);
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
		/* One column no wider than the panel, so a long line cannot widen it. */
		grid-template-columns: minmax(0, 1fr);
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
	/* A docked panel is a column that runs from the page bar (3.75rem from 48rem, with a 1.5rem
	   margin under it) to the bottom of the window and to the main area's right edge. */
	.docked {
		position: sticky;
		top: 3.75rem;
		right: auto;
		bottom: auto;
		z-index: auto;
		width: auto;
		height: calc(100dvh - 3.75rem);
		/* The negative bottom margin lets the column reach past the main area's bottom padding, so
		   it stays under the bar at the end of the page. */
		margin: -1.5rem calc(var(--page-bleed, 0px) * -1) calc(var(--page-bottom, 0px) * -1) 0;
		border-left-color: var(--color-rule-soft);
		background: transparent;
		box-shadow: none;
		animation: none;
	}
	.docked .head {
		min-height: 3rem;
		padding: 0.5rem 0.5rem 0.5rem 1.125rem;
		border-bottom: 0;
	}
	.docked .body {
		padding: 0.25rem 1.125rem 1.5rem;
	}
	/* Wide windows keep the page beside an undocked panel. Below 90rem the page would keep too
	   little width for a list beside the app navigation, so the panel covers it. */
	@media (min-width: 90rem) {
		:global(body:has(.side-panel:not(.docked))) {
			padding-right: var(--side-panel-width);
		}
		.side-panel {
			box-shadow: none;
		}
	}
</style>
