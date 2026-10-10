<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import Glyph from '../icons/Glyph.svelte';

	interface Props {
		name: string;
		value: string;
		checked: boolean;
		label: string;
		description?: string;
		// Tile: icon above the label. Row: icon, label, and a radio mark in one line.
		layout?: 'tile' | 'row';
		icon?: Snippet;
		onselect: (value: string) => void;
	}
	let {
		name,
		value,
		checked,
		label,
		description,
		layout = 'tile',
		icon,
		onselect
	}: Props = $props();
</script>

<label class="choice {layout}" class:checked>
	<input type="radio" {name} {value} {checked} onchange={() => onselect(value)} />
	{#if icon}<span class="icon">{@render icon()}</span>{/if}
	<span class="text">
		<span class="label">{label}</span>
		{#if description}<span class="description">{description}</span>{/if}
	</span>
	<span class="mark" aria-hidden="true"
		>{#if checked}<Glyph name="check" size={14} />{/if}</span
	>
</label>

<style>
	.choice {
		position: relative;
		display: grid;
		justify-items: center;
		align-content: center;
		gap: 0.9rem;
		min-height: 11rem;
		padding: 1.75rem 1.25rem;
		border: 1px solid var(--color-rule);
		border-radius: var(--radius-md, 0.625rem);
		background: var(--color-paper);
		color: var(--color-strong);
		text-align: center;
		cursor: pointer;
		transition:
			border-color var(--dur-fast, 140ms) var(--ease-out, ease),
			background var(--dur-fast, 140ms) var(--ease-out, ease);
	}
	.choice:hover {
		border-color: color-mix(in oklch, var(--color-strong) 35%, var(--color-rule));
	}
	.checked,
	.checked:hover {
		border-color: var(--color-accent);
		box-shadow: 0 0 0 1px var(--color-accent);
		background: var(--color-accent-soft);
	}
	input {
		position: absolute;
		opacity: 0;
		pointer-events: none;
	}
	.choice:has(input:focus-visible) {
		outline: 2px solid var(--color-focus);
		outline-offset: 3px;
	}
	.icon {
		display: grid;
		place-items: center;
		color: var(--color-strong);
	}
	.text {
		display: grid;
		gap: 0.35rem;
	}
	.label {
		font-size: 1.125rem;
		font-weight: 600;
		letter-spacing: -0.015em;
	}
	.description {
		max-width: 16rem;
		color: var(--color-lead);
		font-size: 0.9375rem;
	}
	.mark {
		position: absolute;
		top: 0.85rem;
		right: 0.85rem;
		display: grid;
		place-items: center;
		width: 1.5rem;
		height: 1.5rem;
		border: 1.5px solid var(--color-rule);
		border-radius: 50%;
		background: var(--color-paper);
		color: #fff;
	}
	.checked .mark {
		border-color: var(--color-accent);
		background: var(--color-accent);
	}
	.row {
		grid-template-columns: auto minmax(0, 1fr) auto;
		justify-items: start;
		gap: 1.25rem;
		min-height: 4.5rem;
		padding: 0.9rem 1.25rem 0.9rem 1.5rem;
		text-align: left;
	}
	.row .label {
		font-size: 1.0625rem;
		font-weight: 500;
	}
	.row .mark {
		position: static;
		width: 1.75rem;
		height: 1.75rem;
	}
</style>
