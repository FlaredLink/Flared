<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLSelectAttributes } from 'svelte/elements';
	import Glyph, { type GlyphName } from '../icons/Glyph.svelte';

	type Props = HTMLSelectAttributes & {
		value?: string;
		icon?: GlyphName;
		// Without its own border, for a select inside another field.
		bare?: boolean;
		children: Snippet;
	};
	let {
		value = $bindable(''),
		icon,
		bare = false,
		children,
		class: className = '',
		...rest
	}: Props = $props();
</script>

<span class="select {className}" class:bare class:with-icon={icon}>
	{#if icon}<span class="lead"><Glyph name={icon} size={18} /></span>{/if}
	<select bind:value {...rest}>{@render children()}</select>
	<span class="caret"><Glyph name="caretDown" size={16} /></span>
</span>

<style>
	.select {
		position: relative;
		display: inline-flex;
		align-items: center;
		min-width: 0;
		min-height: 2.75rem;
		border-radius: var(--radius-control, 0.5rem);
		background: var(--color-surface-2);
		box-shadow: var(--shadow-ring);
		color: var(--color-strong);
	}
	.select:focus-within {
		box-shadow: 0 0 0 2px var(--color-focus);
	}
	.bare {
		background: transparent;
		box-shadow: none;
	}
	select {
		width: 100%;
		min-width: 0;
		align-self: stretch;
		padding: 0 2.5rem 0 0.9rem;
		border: 0;
		background: transparent;
		color: inherit;
		font: inherit;
		/* 16px on phones, so iOS does not zoom into the field. */
		font-size: 1rem;
		appearance: none;
		outline: none;
	}
	@media (min-width: 48rem) {
		select {
			font-size: 0.9375rem;
		}
	}
	.with-icon select {
		padding-left: 2.6rem;
	}
	.lead,
	.caret {
		position: absolute;
		display: grid;
		color: var(--color-ink);
		pointer-events: none;
	}
	.lead {
		left: 0.9rem;
	}
	.caret {
		right: 0.9rem;
	}
	select :global(option) {
		background: var(--color-paper);
		color: var(--color-strong);
	}
</style>
