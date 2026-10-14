<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- UTM parameters for a destination. The fields have no name: each change writes its utm_*
     parameter into the bound destination, and the destination field carries it to the server. -->
<script lang="ts">
	import { maxUtmLength, utmKeys, utmOf, withUtm, type UtmKey } from '@flared/contracts/links';
	import TextInput from '../atoms/TextInput.svelte';

	interface Props {
		destination: string;
		// Prefix for the field IDs, unique on the page.
		idPrefix: string;
	}

	let { destination = $bindable(), idPrefix }: Props = $props();

	const labels: Record<UtmKey, { label: string; placeholder: string }> = {
		source: { label: 'Source', placeholder: 'newsletter' },
		medium: { label: 'Medium', placeholder: 'email' },
		campaign: { label: 'Campaign', placeholder: 'spring-sale' },
		term: { label: 'Term', placeholder: 'running shoes' },
		content: { label: 'Content', placeholder: 'header-button' }
	};

	const values = $derived(utmOf(destination));
	const ready = $derived(isUrl(destination));

	function isUrl(value: string): boolean {
		try {
			withUtm(value, {});
			return true;
		} catch {
			return false;
		}
	}

	function change(key: UtmKey, value: string) {
		try {
			destination = withUtm(destination, { [key]: value });
		} catch {
			// The destination is not a URL yet; the fields stay disabled until it is.
		}
	}
</script>

<fieldset class="utm" aria-describedby="{idPrefix}-utm-hint">
	<legend>UTM parameters <span class="optional">optional</span></legend>
	<p id="{idPrefix}-utm-hint" class="hint">
		{ready
			? 'Each value is added to the destination as utm_source, utm_medium, and so on. Clear a field to remove it.'
			: 'Enter the destination URL first.'}
	</p>
	<div class="grid">
		{#each utmKeys as key (key)}
			<div class="field">
				<label for="{idPrefix}-utm-{key}">{labels[key].label}</label>
				<TextInput
					id="{idPrefix}-utm-{key}"
					autocomplete="off"
					maxlength={maxUtmLength}
					placeholder={labels[key].placeholder}
					disabled={!ready}
					value={values[key] ?? ''}
					oninput={(event) => change(key, event.currentTarget.value)}
				/>
			</div>
		{/each}
	</div>
</fieldset>

<style>
	.utm {
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
		grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
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
</style>
