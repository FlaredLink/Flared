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
		width: min(30rem, 100% - 2rem);
		padding: 1.25rem 1.5rem 1.5rem;
		border: 1px solid var(--color-rule);
		border-radius: var(--radius-lg, 0.875rem);
		background: var(--color-paper);
		color: var(--color-ink);
		box-shadow: var(--shadow-float);
		/* Closing: the dialog fades and sinks a little, faster than it opens. overlay and display
		   keep it in the top layer until the fade ends. */
		opacity: 0;
		transform: translateY(0.5rem) scale(0.98);
		transition-property: opacity, transform, overlay, display;
		transition-duration: calc(var(--dur-base) * 0.7);
		transition-timing-function: var(--ease-in);
		transition-behavior: allow-discrete;
	}
	dialog[open] {
		opacity: 1;
		transform: none;
		transition-duration: var(--dur-base);
		transition-timing-function: var(--ease-out);
	}
	@starting-style {
		dialog[open] {
			opacity: 0;
			transform: translateY(0.5rem) scale(0.98);
		}
	}
	dialog::backdrop {
		background: oklch(15% 0.01 265 / 0);
		transition-property: background, overlay, display;
		transition-duration: calc(var(--dur-base) * 0.7);
		transition-behavior: allow-discrete;
	}
	dialog[open]::backdrop {
		background: oklch(15% 0.01 265 / 0.35);
		transition-duration: var(--dur-base);
	}
	@starting-style {
		dialog[open]::backdrop {
			background: oklch(15% 0.01 265 / 0);
		}
	}
	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		margin: 0 -0.5rem 1rem 0;
	}
	h2 {
		color: var(--color-strong);
		font-size: 1.25rem;
		font-weight: 700;
		letter-spacing: -0.02em;
	}
</style>
