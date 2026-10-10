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
		border: 1px solid var(--color-rule);
		border-radius: var(--radius-control, 0.5rem);
		background: var(--color-input);
		color: var(--color-strong);
	}
	.select:focus-within {
		border-color: var(--color-strong);
		outline: 1px solid var(--color-strong);
		outline-offset: -1px;
	}
	.bare {
		border-color: transparent;
		background: transparent;
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
		font-size: 0.9375rem;
		appearance: none;
		outline: none;
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
