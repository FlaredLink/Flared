<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts" module>
	export interface Segment {
		value: string;
		label: string;
		icon?: GlyphName;
	}
</script>

<script lang="ts">
	import Glyph, { type GlyphName } from '../icons/Glyph.svelte';

	interface Props {
		options: Segment[];
		value: string;
		name: string;
		label: string;
		// Solid fills the chosen option with ink; outline marks it with a coral border.
		variant?: 'solid' | 'outline';
		wide?: boolean;
		onchange?: (value: string) => void;
	}
	let {
		options,
		value = $bindable(),
		name,
		label,
		variant = 'solid',
		wide = false,
		onchange
	}: Props = $props();
</script>

<div class="segmented {variant}" class:wide role="radiogroup" aria-label={label}>
	{#each options as option (option.value)}
		<label class:chosen={option.value === value}>
			<input
				type="radio"
				{name}
				value={option.value}
				checked={option.value === value}
				onchange={() => {
					value = option.value;
					onchange?.(option.value);
				}}
			/>
			{#if option.icon}<Glyph name={option.icon} size={18} />{/if}
			<span>{option.label}</span>
		</label>
	{/each}
</div>

<style>
	.segmented {
		display: inline-flex;
		padding: 0.25rem;
		border: 1px solid var(--color-rule);
		border-radius: var(--radius-control, 0.5rem);
		background: var(--color-paper);
	}
	.wide {
		display: flex;
	}
	label {
		position: relative;
		display: inline-flex;
		flex: 1;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		min-height: 2.25rem;
		padding: 0 1.1rem;
		border: 1px solid transparent;
		border-radius: calc(var(--radius-control, 0.5rem) - 0.15rem);
		color: var(--color-ink);
		font-size: 0.9375rem;
		white-space: nowrap;
		cursor: pointer;
	}
	label:hover {
		background: var(--color-hover);
	}
	input {
		position: absolute;
		opacity: 0;
		pointer-events: none;
	}
	label:has(input:focus-visible) {
		outline: 2px solid var(--color-focus);
		outline-offset: 2px;
	}
	.solid .chosen {
		background: var(--color-button-primary);
		color: var(--color-on-primary);
		font-weight: 600;
	}
	.outline {
		padding: 0;
	}
	.outline label {
		min-height: 2.75rem;
		border-radius: var(--radius-control, 0.5rem);
	}
	.outline .chosen {
		border-color: var(--color-accent);
		background: var(--color-accent-soft);
		color: var(--color-strong);
		font-weight: 600;
	}
</style>
