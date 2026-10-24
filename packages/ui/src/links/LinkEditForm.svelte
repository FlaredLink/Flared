<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import ShownWorkspaceField from '../workspace/ShownWorkspaceField.svelte';
	import { untrack } from 'svelte';
	import type { Action } from 'svelte/action';
	import type { Link } from '@flared/contracts/links';
	import Button from '../atoms/Button.svelte';
	import TextInput from '../atoms/TextInput.svelte';
	import FormField from '../molecules/FormField.svelte';
	import AccessFields from './AccessFields.svelte';
	import DeviceFields from './DeviceFields.svelte';
	import PreviewFields from './PreviewFields.svelte';
	import UtmFields from './UtmFields.svelte';

	interface EditValues {
		destination: string;
		title: string;
		iosDestination?: string;
		androidDestination?: string;
		startsAt?: string;
		endsAt?: string;
		endedDestination?: string;
		previewTitle?: string;
		previewDescription?: string;
	}

	interface Props {
		// Form action URL. The app wrapper sends the fields to PATCH /v1/links/:id.
		action: string;
		link: Link;
		// The submitted edit after a failure, so the form keeps what the person typed.
		values?: EditValues | null;
		error?: { message: string; field: string | null } | null;
		pending?: boolean;
		enhance?: Action<HTMLFormElement>;
		// Closes the form without a change. Without it, the form shows no Cancel button.
		oncancel?: () => void;
		// Why the workspace cannot set dates or a password, such as its plan. Without it, it can.
		accessUnavailable?: string | null;
		// Why the workspace cannot set a link card, such as its plan. Without it, it can.
		previewUnavailable?: string | null;
	}

	let {
		action,
		link,
		values = null,
		error = null,
		pending = false,
		enhance = () => {},
		oncancel,
		accessUnavailable = null,
		previewUnavailable = null
	}: Props = $props();

	// A submitted value wins; a device destination that was not submitted shows the link's.
	const shown = $derived({
		destination: values?.destination ?? link.destination,
		title: values?.title ?? link.title ?? '',
		iosDestination: values?.iosDestination ?? link.iosDestination ?? '',
		androidDestination: values?.androidDestination ?? link.androidDestination ?? '',
		startsAt: values?.startsAt ?? link.startsAt ?? '',
		endsAt: values?.endsAt ?? link.endsAt ?? '',
		endedDestination: values?.endedDestination ?? link.endedDestination ?? '',
		previewTitle: values?.previewTitle ?? link.previewTitle ?? '',
		previewDescription: values?.previewDescription ?? link.previewDescription ?? ''
	});
	// Bound to the destination field, so the UTM fields can write into it.
	let destination = $state(untrack(() => shown.destination));
	$effect(() => {
		destination = shown.destination;
	});
	const ownFields = [
		'destination',
		'title',
		'iosDestination',
		'androidDestination',
		'startsAt',
		'endsAt',
		'endedDestination',
		'password',
		'previewTitle',
		'previewDescription',
		'previewImage'
	];
	const invalid = (field: string) => error?.field === field;
	const fieldError = (field: string) => (invalid(field) ? error?.message : null);
	// An error that belongs to no field shows under the buttons.
	const formError = $derived(
		error && !ownFields.includes(error.field ?? '') ? error.message : null
	);
</script>

<form
	method="post"
	{action}
	enctype="multipart/form-data"
	class="edit-form"
	use:enhance
	aria-label="Edit this link"
>
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
			bind:value={destination}
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
	<UtmFields bind:destination idPrefix="edit" />
	<DeviceFields idPrefix="edit" values={shown} {error} />
	<AccessFields
		idPrefix="edit"
		values={shown}
		hasPassword={link.hasPassword ?? false}
		{error}
		unavailable={accessUnavailable}
	/>
	<PreviewFields
		idPrefix="edit"
		values={shown}
		image={link.previewImage ?? null}
		{error}
		unavailable={previewUnavailable}
	/>
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
