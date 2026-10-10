<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLInputAttributes } from 'svelte/elements';

	type Props = Omit<HTMLInputAttributes, 'type'> & {
		checked?: boolean;
		children: Snippet;
		hint?: string;
	};
	let { checked = $bindable(false), children, hint, ...rest }: Props = $props();
</script>

<label class="checkbox">
	<input type="checkbox" bind:checked {...rest} />
	<span class="text"
		><span class="name">{@render children()}</span>{#if hint}<span class="hint">{hint}</span
			>{/if}</span
	>
</label>

<style>
	.checkbox {
		display: flex;
		align-items: flex-start;
		gap: 0.7rem;
		min-height: 2.25rem;
		padding-top: 0.35rem;
		color: var(--color-strong);
		font-size: 0.9375rem;
		cursor: pointer;
	}
	input {
		width: 1.15rem;
		height: 1.15rem;
		flex: none;
		margin: 0.15rem 0 0;
		accent-color: var(--color-accent);
		cursor: pointer;
	}
	.text {
		display: grid;
		gap: 0.1rem;
	}
	.hint {
		color: var(--color-muted);
		font-size: 0.8125rem;
	}
</style>
