<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import Button, { type ButtonSize, type ButtonVariant } from '../atoms/Button.svelte';
	import IconButton from '../atoms/IconButton.svelte';

	interface Props {
		text: string;
		// The accessible name, such as "Copy link". The button form shows it as the label.
		label: string;
		// Icon only, or a full button with the label.
		kind?: 'icon' | 'button';
		variant?: ButtonVariant;
		size?: ButtonSize;
		wide?: boolean;
		oncopied?: () => void;
	}
	let {
		text,
		label,
		kind = 'icon',
		variant = 'secondary',
		size = 'md',
		wide = false,
		oncopied
	}: Props = $props();
	let state = $state<'idle' | 'copied' | 'failed'>('idle');
	let timer: ReturnType<typeof setTimeout> | undefined;

	async function copy() {
		clearTimeout(timer);
		try {
			await navigator.clipboard.writeText(text);
			state = 'copied';
			oncopied?.();
		} catch {
			state = 'failed';
		}
		timer = setTimeout(() => (state = 'idle'), 2000);
	}
	const message = $derived(
		state === 'copied'
			? 'Copied'
			: state === 'failed'
				? 'Copy failed. Select the text instead.'
				: ''
	);
</script>

{#if kind === 'icon'}
	<IconButton
		icon={state === 'copied' ? 'check' : 'copy'}
		{label}
		size={size === 'sm' ? 'sm' : 'md'}
		class={state === 'copied' ? 'copied' : ''}
		onclick={copy}
	/>
{:else}
	<Button {variant} {size} {wide} icon={state === 'copied' ? 'check' : 'copy'} onclick={copy}
		>{state === 'copied' ? 'Copied' : label}</Button
	>
{/if}
<span class="visually-hidden" role="status">{message}</span>

<style>
	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
	:global(.icon-button.copied) {
		color: var(--color-accent-ink);
	}
</style>
