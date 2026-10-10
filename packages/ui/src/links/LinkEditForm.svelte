<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import ShownWorkspaceField from '../workspace/ShownWorkspaceField.svelte';
	import type { Action } from 'svelte/action';
	import type { Link } from '@flared/contracts/links';
	import Button from '../atoms/Button.svelte';
	import TextInput from '../atoms/TextInput.svelte';
	import FormField from '../molecules/FormField.svelte';

	interface Props {
		// Form action URL. The app wrapper sends the fields to PATCH /v1/links/:id.
		action: string;
		link: Link;
		// The submitted edit after a failure, so the form keeps what the person typed.
		values?: { destination: string; title: string } | null;
		error?: { message: string; field: string | null } | null;
		pending?: boolean;
		enhance?: Action<HTMLFormElement>;
		// Closes the form without a change. Without it, the form shows no Cancel button.
		oncancel?: () => void;
	}

	let {
		action,
		link,
		values = null,
		error = null,
		pending = false,
		enhance = () => {},
		oncancel
	}: Props = $props();

	const shown = $derived(values ?? { destination: link.destination, title: link.title ?? '' });
	const invalid = (field: string) => error?.field === field;
	const fieldError = (field: string) => (invalid(field) ? error?.message : null);
	// An error that belongs to no field shows under the buttons.
	const formError = $derived(
		error && error.field !== 'destination' && error.field !== 'title' ? error.message : null
	);
</script>

<form method="post" {action} class="edit-form" use:enhance aria-label="Edit this link">
	<input type="hidden" name="intent" value="edit" />
	<ShownWorkspaceField />
	<FormField for="edit-destination" label="Destination URL" error={fieldError('destination')}>
		<TextInput
			id="edit-destination"
			name="destination"
			type="url"
			inputmode="url"
			autocomplete="off"
			maxlength={4096}
			required
			icon="link"
			value={shown.destination}
			invalid={invalid('destination')}
			aria-describedby={invalid('destination') ? 'edit-destination-error' : 'edit-hint'}
		/>
	</FormField>
	<FormField for="edit-title" label="Title (optional)" error={fieldError('title')}>
		<TextInput
			id="edit-title"
			name="title"
			maxlength={200}
			autocomplete="off"
			placeholder="Spring launch"
			value={shown.title}
			invalid={invalid('title')}
			aria-describedby={invalid('title') ? 'edit-title-error' : undefined}
		/>
	</FormField>
	<p id="edit-hint" class="hint">
		The short link {link.hostname}/{link.slug} stays the same. New clicks go to the new destination.
	</p>
	{#if formError}<p class="error" role="alert">{formError}</p>{/if}
	<div class="row">
		<Button variant="primary" type="submit" disabled={pending}
			>{pending ? 'Saving…' : 'Save changes'}</Button
		>
		{#if oncancel}<Button type="button" onclick={oncancel}>Cancel</Button>{/if}
	</div>
</form>

<style>
	.edit-form {
		display: grid;
		gap: 1.1rem;
	}
	.hint {
		color: var(--color-lead);
		font-size: 0.875rem;
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.6rem;
	}
	.error {
		color: var(--color-danger);
		font-size: 0.875rem;
	}
</style>
