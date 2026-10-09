<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import type { Action } from 'svelte/action';
	import type { Link } from '@flared/contracts/links';

	interface Props {
		// Form action URL. The app wrapper sends the fields to PATCH /v1/links/:id.
		action: string;
		link: Link;
		// The submitted edit after a failure, so the form keeps what the person typed.
		values?: { destination: string; title: string } | null;
		error?: { message: string; field: string | null } | null;
		// A short confirmation after a change, such as "Saved."
		notice?: string;
		pending?: boolean;
		enhance?: Action<HTMLFormElement>;
	}

	let {
		action,
		link,
		values = null,
		error = null,
		notice = '',
		pending = false,
		enhance = () => {}
	}: Props = $props();

	let editing = $state(false);
	// A failed edit keeps the form open with the submitted values; a saved change reloads the link
	// and closes it.
	$effect.pre(() => {
		void link;
		editing = Boolean(error && values);
	});
	const invalid = (field: string) => editing && error?.field === field;
	const shown = $derived(values ?? { destination: link.destination, title: link.title ?? '' });
</script>

<section class="link-edit" aria-label="Change this link">
	{#if editing}
		<form method="post" {action} class="edit-form" use:enhance>
			<input type="hidden" name="intent" value="edit" />
			<div class="field">
				<label for="edit-destination">Destination URL</label>
				<input
					id="edit-destination"
					name="destination"
					type="url"
					inputmode="url"
					autocomplete="off"
					maxlength="4096"
					required
					value={shown.destination}
					aria-invalid={invalid('destination') || undefined}
					aria-describedby={invalid('destination') ? 'link-edit-error' : undefined}
				/>
			</div>
			<div class="field">
				<label for="edit-title">Title <span class="optional">optional</span></label>
				<input
					id="edit-title"
					name="title"
					maxlength="200"
					autocomplete="off"
					value={shown.title}
					aria-invalid={invalid('title') || undefined}
					aria-describedby={invalid('title') ? 'link-edit-error' : undefined}
				/>
			</div>
			<p class="hint">The short link stays the same. New clicks go to the new destination.</p>
			{#if error}<p id="link-edit-error" class="error" role="alert">{error.message}</p>{/if}
			<div class="row">
				<button class="button primary" type="submit" disabled={pending}
					>{pending ? 'Saving…' : 'Save changes'}</button
				>
				<button class="button secondary" type="button" onclick={() => (editing = false)}
					>Cancel</button
				>
			</div>
		</form>
	{:else}
		<div class="row">
			<button class="button secondary" type="button" onclick={() => (editing = true)}
				>Edit link</button
			>
			<form method="post" {action} use:enhance>
				<input type="hidden" name="intent" value={link.enabled ? 'disable' : 'enable'} />
				<button class="button secondary" type="submit" disabled={pending}
					>{link.enabled ? 'Disable link' : 'Enable link'}</button
				>
			</form>
		</div>
		{#if error}<p class="error" role="alert">{error.message}</p>{/if}
	{/if}
	<p class="edit-status" role="status" aria-live="polite">{notice}</p>
</section>

<style>
	.link-edit {
		display: grid;
		gap: 0.5rem;
	}
	.edit-form {
		display: grid;
		gap: 0.9rem;
		max-width: 44rem;
		padding: 1.25rem 1.5rem;
		border: 1px solid var(--color-rule, #eaecf0);
		border-radius: var(--radius-lg, 12px);
		background: var(--color-surface, #fff);
	}
	.field {
		display: grid;
		gap: 0.4rem;
	}
	label {
		color: var(--color-strong, #101828);
		font-size: 0.85rem;
		font-weight: 650;
	}
	.optional {
		color: var(--color-muted, #667085);
		font-weight: 500;
	}
	input {
		width: 100%;
		min-width: 0;
		min-height: 44px;
		padding: 0.6rem 0.8rem;
		border: 1px solid var(--color-rule, #d0d5dd);
		border-radius: var(--radius-sm, 6px);
		background: var(--color-input, #fff);
		color: var(--color-ink, #101828);
	}
	input:focus-visible {
		border-color: var(--color-muted, #667085);
		outline: 1px solid var(--color-muted, #667085);
		outline-offset: -1px;
	}
	input[aria-invalid='true'] {
		border-color: var(--color-danger, #b42318);
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}
	.hint,
	.edit-status {
		color: var(--color-muted, #667085);
		font-size: 0.8rem;
	}
	.edit-status:empty {
		display: none;
	}
	.error {
		color: var(--color-danger, #b42318);
		font-size: 0.85rem;
	}
</style>
