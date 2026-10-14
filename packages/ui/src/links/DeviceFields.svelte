<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Device destinations: where iPhone and Android visitors go instead of the destination. -->
<script lang="ts">
	import TextInput from '../atoms/TextInput.svelte';

	interface Props {
		values: { iosDestination: string; androidDestination: string };
		// Prefix for the field IDs, unique on the page.
		idPrefix: string;
		error?: { message: string; field: string | null } | null;
		// The ID of a message that the form already shows. Without it, the error shows here.
		errorId?: string;
	}

	let { values, idPrefix, error = null, errorId }: Props = $props();

	const fields = [
		{
			name: 'iosDestination',
			label: 'iPhone',
			placeholder: 'https://example.com/app/item or myapp://item'
		},
		{
			name: 'androidDestination',
			label: 'Android',
			placeholder: 'https://example.com/app/item or intent://…'
		}
	] as const;
	const invalid = (field: string) => error?.field === field;
	const describedBy = $derived(errorId ?? `${idPrefix}-devices-error`);
</script>

<fieldset class="devices" aria-describedby="{idPrefix}-devices-hint">
	<legend>App links <span class="optional">optional</span></legend>
	<p id="{idPrefix}-devices-hint" class="hint">
		Visitors on iPhone or Android go here, such as to your app. Use a universal or app link (https),
		or an app scheme such as myapp://. Everyone else, and link previews, go to the destination.
	</p>
	<div class="grid">
		{#each fields as field (field.name)}
			<div class="field">
				<label for="{idPrefix}-{field.name}">{field.label}</label>
				<TextInput
					id="{idPrefix}-{field.name}"
					name={field.name}
					autocomplete="off"
					autocapitalize="none"
					spellcheck="false"
					maxlength={4096}
					placeholder={field.placeholder}
					value={values[field.name]}
					invalid={invalid(field.name)}
					aria-describedby={invalid(field.name) ? describedBy : undefined}
				/>
			</div>
		{/each}
	</div>
	{#if !errorId && error && (invalid('iosDestination') || invalid('androidDestination'))}
		<p id="{idPrefix}-devices-error" class="error" role="alert">{error.message}</p>
	{/if}
</fieldset>

<style>
	.devices {
		display: grid;
		gap: 0.6rem;
		min-width: 0;
		margin: 0;
		padding: 0;
		border: 0;
	}
	legend {
		padding: 0;
		color: var(--color-strong);
		font-size: 0.9375rem;
		font-weight: 600;
	}
	.optional {
		color: var(--color-lead);
		font-weight: 400;
	}
	.hint {
		color: var(--color-lead);
		font-size: 0.875rem;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
		gap: 0.75rem;
	}
	.field {
		display: grid;
		gap: 0.35rem;
		min-width: 0;
	}
	.field label {
		color: var(--color-strong);
		font-size: 0.875rem;
	}
	.error {
		color: var(--color-danger);
		font-size: 0.875rem;
	}
</style>
