<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import IconButton from '../atoms/IconButton.svelte';

	interface Props {
		open: boolean;
		title: string;
		id: string;
		children: Snippet;
		onclose?: () => void;
	}
	let { open = $bindable(), title, id, children, onclose }: Props = $props();
	let dialog = $state<HTMLDialogElement>();

	$effect(() => {
		if (!dialog) return;
		if (open && !dialog.open) dialog.showModal();
		if (!open && dialog.open) dialog.close();
	});
</script>

<dialog
	bind:this={dialog}
	aria-labelledby={id}
	onclose={() => {
		open = false;
		onclose?.();
	}}
	onclick={(event) => {
		if (event.target === dialog) dialog?.close();
	}}
>
	<div class="head">
		<h2 {id}>{title}</h2>
		<IconButton icon="x" label="Close" size="sm" onclick={() => dialog?.close()} />
	</div>
	{@render children()}
</dialog>

<style>
	dialog {
		width: min(35rem, 100% - 2rem);
		max-height: calc(100dvh - 2rem);
		padding: 1.125rem;
		border: 0;
		border-radius: 1rem;
		background: var(--color-surface);
		color: var(--color-ink);
		box-shadow: var(--shadow-lift);
		overscroll-behavior: contain;
		/* Closing: the dialog fades and sinks a little, faster than it opens. overlay and display
		   keep it in the top layer until the fade ends. */
		opacity: 0;
		transform: translateY(0.5rem) scale(0.98);
		transition-property: opacity, transform, overlay, display;
		transition-duration: calc(var(--dur-base) * 0.7);
		transition-timing-function: var(--ease-out);
		transition-behavior: allow-discrete;
	}
	dialog[open] {
		opacity: 1;
		transform: none;
		transition-duration: var(--dur-base);
	}
	@starting-style {
		dialog[open] {
			opacity: 0;
			transform: translateY(0.5rem) scale(0.98);
		}
	}
	dialog::backdrop {
		background: rgb(10 10 10 / 0);
		backdrop-filter: blur(0);
		transition-property: background, backdrop-filter, overlay, display;
		transition-duration: calc(var(--dur-base) * 0.7);
		transition-behavior: allow-discrete;
	}
	dialog[open]::backdrop {
		background: rgb(10 10 10 / 0.32);
		backdrop-filter: blur(2px);
		transition-duration: var(--dur-base);
	}
	@starting-style {
		dialog[open]::backdrop {
			background: rgb(10 10 10 / 0);
			backdrop-filter: blur(0);
		}
	}
	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		margin: 0 -0.375rem 0.75rem 0;
	}
	h2 {
		color: var(--color-strong);
		font-size: 1rem;
		font-weight: 600;
		letter-spacing: -0.01em;
	}
</style>
