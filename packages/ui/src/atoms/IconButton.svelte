<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import type { HTMLButtonAttributes } from 'svelte/elements';
	import Glyph, { type GlyphName } from '../icons/Glyph.svelte';

	// The label names the action for screen readers and shows as a tooltip.
	type Props = HTMLButtonAttributes & {
		icon: GlyphName;
		label: string;
		outlined?: boolean;
		size?: 'sm' | 'md';
	};
	let {
		icon,
		label,
		outlined = false,
		size = 'md',
		class: className = '',
		...rest
	}: Props = $props();
</script>

<button
	type="button"
	class="icon-button {size} {className}"
	class:outlined
	aria-label={label}
	title={label}
	{...rest}><Glyph name={icon} size={size === 'sm' ? 18 : 20} /></button
>

<style>
	.icon-button {
		display: inline-grid;
		flex: none;
		place-items: center;
		padding: 0;
		border: 1px solid transparent;
		border-radius: var(--radius-control, 0.5rem);
		background: transparent;
		color: var(--color-ink);
		cursor: pointer;
	}
	.sm {
		width: 2.25rem;
		height: 2.25rem;
	}
	.md {
		width: 2.75rem;
		height: 2.75rem;
	}
	.outlined {
		border-color: var(--color-rule);
		background: var(--color-paper);
	}
	.icon-button:hover:not(:disabled),
	.icon-button[aria-expanded='true'] {
		background: var(--color-hover);
		color: var(--color-strong);
	}
	.icon-button:disabled {
		color: var(--color-muted);
		cursor: not-allowed;
		opacity: 0.6;
	}
</style>
