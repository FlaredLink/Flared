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

	// On a phone the soft keyboard covers the bottom of the layout viewport, so the sheet rises by
	// the covered height while it is open.
	$effect(() => {
		const viewport = window.visualViewport;
		if (!open || !dialog || !viewport) return;
		const sheet = dialog;
		const place = () => {
			const covered = window.innerHeight - viewport.height - viewport.offsetTop;
			sheet.style.setProperty('--keyboard-inset', `${Math.max(0, Math.round(covered))}px`);
		};
		place();
		viewport.addEventListener('resize', place);
		viewport.addEventListener('scroll', place);
		return () => {
			viewport.removeEventListener('resize', place);
			viewport.removeEventListener('scroll', place);
		};
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
	<span class="handle" aria-hidden="true"></span>
	<div class="head">
		<h2 {id}>{title}</h2>
		<IconButton icon="x" label="Close" size="sm" onclick={() => dialog?.close()} />
	</div>
	{@render children()}
</dialog>

<style>
	/* Phone: a bottom sheet with a grab handle. From 48rem: a centred dialog. Esc, the close
	   button, and a tap on the backdrop close both. */
	dialog {
		inset: auto 0 var(--keyboard-inset, 0px);
		width: 100%;
		max-width: none;
		max-height: calc(100dvh - 3.5rem - var(--keyboard-inset, 0px));
		margin: 0;
		padding: 0.5rem 1rem calc(1.5rem + env(safe-area-inset-bottom));
		overflow: auto;
		border: 0;
		border-radius: 1.375rem 1.375rem 0 0;
		background: var(--color-surface);
		color: var(--color-ink);
		box-shadow: var(--shadow-lift);
		overscroll-behavior: contain;
		/* Closing: the dialog fades and sinks a little, faster than it opens. overlay and display
		   keep it in the top layer until the fade ends. */
		opacity: 0;
		transform: translateY(1.5rem);
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
			transform: translateY(1.5rem);
		}
	}
	.handle {
		display: block;
		width: 2.25rem;
		height: 5px;
		margin: 0 auto 0.5rem;
		border-radius: 3px;
		background: var(--color-faint);
	}
	@media (min-width: 48rem) {
		dialog {
			inset: 0;
			width: min(35rem, 100% - 2rem);
			max-height: calc(100dvh - 2rem);
			margin: auto;
			padding: 1.125rem;
			border-radius: 1rem;
			transform: translateY(0.5rem) scale(0.98);
		}
		@starting-style {
			dialog[open] {
				transform: translateY(0.5rem) scale(0.98);
			}
		}
		.handle {
			display: none;
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
		font-size: 1.125rem;
		font-weight: 600;
		letter-spacing: -0.01em;
	}
	@media (min-width: 48rem) {
		h2 {
			font-size: 1rem;
		}
	}
</style>
