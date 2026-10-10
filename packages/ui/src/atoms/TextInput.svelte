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
		border: 1px solid var(--color-rule);
		border-radius: var(--radius-control, 0.5rem);
		background: var(--color-input);
		color: var(--color-muted);
	}
	.text-input:focus-within {
		border-color: var(--color-strong);
		outline: 1px solid var(--color-strong);
		outline-offset: -1px;
	}
	.invalid {
		border-color: var(--color-danger);
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
		font-size: 0.9375rem;
		outline: none;
	}
	.mono input {
		font-family: var(--font-mono);
		font-size: 0.875rem;
	}
	input::placeholder {
		color: var(--color-muted);
	}
	input:read-only {
		cursor: default;
	}
</style>
