<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts" module>
	export interface LinkFormValues {
		destination: string;
		slug: string;
		title: string;
		// Empty or absent means the installation default.
		domainId?: string;
	}

	export interface LinkFormDomain {
		id: string;
		hostname: string;
		isDefault: boolean;
	}
</script>

<script lang="ts">
	import { onMount } from 'svelte';
	import type { Action } from 'svelte/action';

	interface Props {
		// Form action URL. The app wrapper sends the fields to POST /v1/links.
		action: string;
		// Sent as Idempotency-Key, so a repeated submit cannot create a second link.
		idempotencyKey: string;
		shortHost: string;
		values?: LinkFormValues;
		error?: { message: string; field: string | null } | null;
		pending?: boolean;
		enhance?: Action<HTMLFormElement>;
		// Active domains for the picker. Without it, or with only one, links use shortHost.
		domains?: LinkFormDomain[];
	}

	let {
		action,
		idempotencyKey,
		shortHost,
		values = { destination: '', slug: '', title: '' },
		error = null,
		pending = false,
		enhance = () => {},
		domains = []
	}: Props = $props();

	const invalid = (field: string) => error?.field === field;

	// The last domain used in this browser. Only a preference: a stale ID is ignored.
	const storageKey = 'flared:link-domain';
	// The default domain is sent as an empty value, so the API applies its own default.
	const choices = $derived([
		...(domains.some((domain) => domain.isDefault) ? [] : [{ value: '', hostname: shortHost }]),
		...domains.map((domain) => ({
			value: domain.isDefault ? '' : domain.id,
			hostname: domain.hostname
		}))
	]);
	const showPicker = $derived(choices.length > 1);
	const isChoice = (value: string) => choices.some((choice) => choice.value === value);
	let selected = $state('');
	let picker = $state<HTMLSelectElement>();
	const previewHost = $derived(
		choices.find((choice) => choice.value === selected)?.hostname ?? shortHost
	);

	function remembered(): string {
		try {
			const value = localStorage.getItem(storageKey) ?? '';
			return isChoice(value) ? value : '';
		} catch {
			return '';
		}
	}

	function remember() {
		try {
			if (selected) localStorage.setItem(storageKey, selected);
			else localStorage.removeItem(storageKey);
		} catch {
			// Storage can be blocked; the picker still works for this page.
		}
	}

	onMount(() => {
		const submitted = values.domainId ?? '';
		selected = submitted && isChoice(submitted) ? submitted : remembered();
	});

	// A successful create resets the form; keep the domain that was just used.
	function restoreAfterReset() {
		setTimeout(() => {
			const value = remembered();
			if (picker) picker.value = value;
			selected = value;
		}, 0);
	}
</script>

<form
	method="post"
	{action}
	class="link-form"
	use:enhance
	onsubmit={remember}
	onreset={restoreAfterReset}
	aria-labelledby="create-link-heading"
>
	<h2 id="create-link-heading">Create a short link</h2>
	<input type="hidden" name="idempotencyKey" value={idempotencyKey} />
	<div class="field">
		<label for="link-destination">Destination URL</label>
		<input
			id="link-destination"
			name="destination"
			type="url"
			inputmode="url"
			autocomplete="off"
			placeholder="https://example.com/launch"
			maxlength="4096"
			required
			value={values.destination}
			aria-invalid={invalid('destination') || undefined}
			aria-describedby={invalid('destination') ? 'link-form-error' : undefined}
		/>
	</div>
	{#if showPicker}
		<div class="field domain">
			<label for="link-domain">Domain</label>
			<select
				id="link-domain"
				name="domainId"
				bind:this={picker}
				bind:value={selected}
				aria-invalid={invalid('domainId') || undefined}
				aria-describedby={invalid('domainId') ? 'link-form-error' : undefined}
			>
				{#each choices as choice (choice.value)}
					<option value={choice.value}>{choice.hostname}</option>
				{/each}
			</select>
		</div>
	{/if}
	<div class="row">
		<div class="field">
			<label for="link-slug">Slug <span class="optional">optional</span></label>
			<div class="slug">
				<span class="prefix" aria-hidden="true">{previewHost}/</span>
				<input
					id="link-slug"
					name="slug"
					type="text"
					autocomplete="off"
					autocapitalize="none"
					spellcheck="false"
					placeholder="random"
					minlength="3"
					maxlength="64"
					pattern="[a-z0-9]([a-z0-9\-]*[a-z0-9])?"
					title="3 to 64 lowercase letters, digits, or hyphens"
					value={values.slug}
					aria-invalid={invalid('slug') || undefined}
					aria-describedby={invalid('slug') ? 'link-form-error link-slug-hint' : 'link-slug-hint'}
				/>
			</div>
			<p id="link-slug-hint" class="hint">
				Leave empty for a random slug. A slug cannot change later.
			</p>
		</div>
		<div class="field">
			<label for="link-title">Title <span class="optional">optional</span></label>
			<input
				id="link-title"
				name="title"
				type="text"
				autocomplete="off"
				maxlength="200"
				placeholder="Spring launch"
				value={values.title}
				aria-invalid={invalid('title') || undefined}
				aria-describedby={invalid('title') ? 'link-form-error' : undefined}
			/>
		</div>
	</div>
	{#if error}<p id="link-form-error" class="error" role="alert">{error.message}</p>{/if}
	<button type="submit" disabled={pending}>{pending ? 'Creating…' : 'Create link'}</button>
</form>

<style>
	.link-form {
		display: grid;
		gap: 1rem;
		max-width: 44rem;
		padding: 1.25rem;
		border: 1px solid var(--color-rule, #d0d5dd);
		border-radius: var(--radius-md, 8px);
		background: var(--color-paper, #fff);
	}
	h2 {
		font-size: 1.05rem;
	}
	.row {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 1rem;
	}
	.field {
		display: grid;
		gap: 0.4rem;
		min-width: 0;
		align-content: start;
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
	input,
	select {
		width: 100%;
		min-width: 0;
		min-height: 44px;
		padding: 0.6rem 0.8rem;
		color: var(--color-ink, #101828);
		border: 1px solid var(--color-rule, #d0d5dd);
		border-radius: var(--radius-sm, 6px);
		background: var(--color-paper, #fff);
	}
	input:focus-visible,
	select:focus-visible {
		border-color: var(--color-muted, #667085);
		outline: 1px solid var(--color-muted, #667085);
		outline-offset: -1px;
	}
	.domain {
		max-width: 20rem;
	}
	input[aria-invalid='true'],
	select[aria-invalid='true'] {
		border-color: var(--color-accent-ink, #b42318);
	}
	.slug {
		display: flex;
		align-items: center;
		min-width: 0;
		border: 1px solid var(--color-rule, #d0d5dd);
		border-radius: var(--radius-sm, 6px);
		background: var(--color-paper, #fff);
	}
	.slug:focus-within {
		border-color: var(--color-muted, #667085);
		outline: 1px solid var(--color-muted, #667085);
		outline-offset: -1px;
	}
	.slug input {
		border: 0;
		padding-left: 0;
	}
	.slug input:focus-visible {
		outline: none;
	}
	.prefix {
		padding-left: 0.8rem;
		color: var(--color-muted, #667085);
		white-space: nowrap;
	}
	.hint {
		color: var(--color-muted, #667085);
		font-size: 0.8rem;
	}
	.error {
		color: var(--color-accent-ink, #b42318);
		font-size: 0.85rem;
	}
	button {
		justify-self: start;
		min-height: 44px;
		padding: 0.65rem 1.15rem;
		border: 1px solid var(--color-button-primary, #101828);
		border-radius: var(--radius-sm, 6px);
		background: var(--color-button-primary, #101828);
		color: var(--color-on-primary, #fff);
		font-weight: 620;
	}
	button:hover:not(:disabled) {
		background: var(--color-button-primary-hover, #344054);
		border-color: var(--color-button-primary-hover, #344054);
	}
	button:disabled {
		color: var(--color-muted, #667085);
		background: var(--color-disabled, #eaecf0);
		border-color: var(--color-disabled, #eaecf0);
	}
	@media (max-width: 40rem) {
		.row {
			grid-template-columns: minmax(0, 1fr);
		}
		button {
			justify-self: stretch;
		}
	}
</style>
