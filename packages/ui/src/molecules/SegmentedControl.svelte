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
		wide?: boolean;
		onchange?: (value: string) => void;
	}
	let { options, value = $bindable(), name, label, wide = false, onchange }: Props = $props();
</script>

<div class="segmented" class:wide role="radiogroup" aria-label={label}>
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
			{#if option.icon}<Glyph name={option.icon} size={16} />{/if}
			<span>{option.label}</span>
		</label>
	{/each}
</div>

<style>
	/* The chosen option is a raised surface on a grey track. */
	.segmented {
		display: inline-flex;
		gap: 0.125rem;
		padding: 0.1875rem;
		border-radius: var(--radius-md, 0.625rem);
		background: var(--color-surface-2);
		box-shadow: var(--shadow-ring);
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
		gap: 0.375rem;
		min-height: 2.125rem;
		padding: 0 0.75rem;
		border-radius: var(--radius-control, 0.5rem);
		color: var(--color-muted);
		font-size: 0.8125rem;
		white-space: nowrap;
		cursor: pointer;
		transition:
			background var(--dur-fast) var(--ease-out),
			color var(--dur-fast) var(--ease-out);
	}
	/* Touch screens get a 44px target. */
	@media (pointer: coarse) {
		label {
			min-height: 2.75rem;
		}
	}
	label:hover {
		color: var(--color-strong);
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
	.chosen {
		background: var(--color-surface);
		box-shadow: var(--shadow-ring);
		color: var(--color-strong);
		font-weight: 500;
	}
</style>
