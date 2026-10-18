<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLInputAttributes } from 'svelte/elements';
	import Glyph, { type GlyphName } from '../icons/Glyph.svelte';

	type Props = HTMLInputAttributes & {
		value?: string;
		icon?: GlyphName;
		mono?: boolean;
		invalid?: boolean;
		// Content inside the box after the input, such as a copy button.
		end?: Snippet;
		input?: HTMLInputElement;
	};
	let {
		value = $bindable(''),
		input = $bindable(),
		icon,
		mono = false,
		invalid = false,
		end,
		class: className = '',
		...rest
	}: Props = $props();
</script>

<span class="text-input {className}" class:invalid class:mono>
	{#if icon}<Glyph name={icon} size={20} />{/if}
	<input bind:value bind:this={input} aria-invalid={invalid || undefined} {...rest} />
	{#if end}{@render end()}{/if}
</span>

<style>
	.text-input {
		display: flex;
		align-items: center;
		gap: 0.65rem;
		min-width: 0;
		min-height: 2.75rem;
		padding: 0 0.9rem;
		border-radius: var(--radius-control, 0.5rem);
		background: var(--color-surface-2);
		box-shadow: var(--shadow-ring);
		color: var(--color-muted);
	}
	.text-input:focus-within {
		box-shadow: 0 0 0 2px var(--color-focus);
	}
	.invalid {
		box-shadow: 0 0 0 1px var(--color-danger);
	}
	input {
		flex: 1;
		min-width: 0;
		align-self: stretch;
		padding: 0;
		border: 0;
		background: transparent;
		color: var(--color-strong);
		font: inherit;
		/* 16px on phones, so iOS does not zoom into the field. */
		font-size: 1rem;
		outline: none;
	}
	.mono input {
		font-family: var(--font-mono);
	}
	@media (min-width: 48rem) {
		input {
			font-size: 0.9375rem;
		}
		.mono input {
			font-size: 0.875rem;
		}
	}
	input::placeholder {
		color: var(--color-subtle);
	}
	input:read-only {
		cursor: default;
	}
</style>
