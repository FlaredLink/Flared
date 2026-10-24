<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import type { Page, PageImageSlot } from '@flared/contracts/pages';
	import Button from '../atoms/Button.svelte';
	import { shownWorkspace } from '../workspace/shown';
	import { pageErrorMessage, removePageImage, setPageImage } from './client';

	interface Props {
		apiBase: string;
		page: Page;
		slot: PageImageSlot;
		label: string;
		hint: string;
		disabled?: boolean;
		// The page after an upload or a removal; images save at once, apart from Save.
		onchange: (page: Page) => void;
	}

	let { apiBase, page, slot, label, hint, disabled = false, onchange }: Props = $props();
	const id = $props.id();
	const workspace = shownWorkspace();

	let input = $state<HTMLInputElement>();
	let pending = $state(false);
	let error = $state('');
	let broken = $state(false);
	const image = $derived(slot === 'avatar' ? page.avatarImage : page.backgroundImage);
	$effect(() => {
		void image;
		broken = false;
	});

	async function upload(file: File) {
		pending = true;
		error = '';
		const result = await setPageImage(apiBase, page.id, slot, file, workspace());
		pending = false;
		if (input) input.value = '';
		if (result.ok) onchange(result.value);
		else error = pageErrorMessage(result.failure);
	}

	async function remove() {
		pending = true;
		error = '';
		const result = await removePageImage(apiBase, page.id, slot, workspace());
		pending = false;
		if (result.ok) onchange(result.value);
		else error = pageErrorMessage(result.failure);
	}
</script>

<div class="image-field">
	<span class="label" id="{id}-label">{label}</span>
	<div class="row">
		<span class="thumb" class:round={slot === 'avatar'}>
			{#if image && !broken}
				<img src={image} alt="" onerror={() => (broken = true)} />
			{:else if image}
				<span class="placeholder">Saved</span>
			{:else}
				<span class="placeholder">None</span>
			{/if}
		</span>
		<div class="actions">
			<input
				bind:this={input}
				id="{id}-file"
				type="file"
				accept="image/png,image/jpeg,image/webp"
				class="file"
				tabindex="-1"
				aria-labelledby="{id}-label"
				aria-describedby="{id}-hint"
				disabled={disabled || pending}
				onchange={(event) => {
					const file = event.currentTarget.files?.[0];
					if (file) void upload(file);
				}}
			/>
			<Button size="sm" icon="image" disabled={disabled || pending} onclick={() => input?.click()}
				>{pending ? 'Saving…' : image ? 'Replace' : 'Upload'}</Button
			>
			{#if image}
				<Button
					size="sm"
					variant="ghost"
					disabled={disabled || pending}
					onclick={() => void remove()}>Remove</Button
				>
			{/if}
		</div>
	</div>
	<p class="hint" id="{id}-hint">{hint}</p>
	{#if error}<p class="error" role="alert">{error}</p>{/if}
</div>

<style>
	.image-field {
		display: grid;
		gap: 0.375rem;
	}
	.label {
		color: var(--color-strong);
		font-size: 0.875rem;
		font-weight: 500;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}
	.thumb {
		display: grid;
		overflow: hidden;
		flex: none;
		place-items: center;
		width: 3.5rem;
		height: 3.5rem;
		border-radius: 0.625rem;
		background: var(--color-surface-2);
		box-shadow: var(--shadow-ring);
	}
	.thumb.round {
		border-radius: 50%;
	}
	.thumb img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.placeholder {
		color: var(--color-subtle);
		font-size: 0.75rem;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.375rem;
	}
	.file {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
	.hint {
		color: var(--color-lead);
		font-size: 0.8125rem;
	}
	.error {
		color: var(--color-danger);
		font-size: 0.875rem;
	}
</style>
