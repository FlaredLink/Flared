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
	import Glyph from '../icons/Glyph.svelte';

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
		// The destination field, for a shortcut that focuses it.
		destinationInput?: HTMLInputElement;
	}

	let {
		action,
		idempotencyKey,
		shortHost,
		values = { destination: '', slug: '', title: '' },
		error = null,
		pending = false,
		enhance = () => {},
		domains = [],
		destinationInput = $bindable()
	}: Props = $props();

	const invalid = (field: string) => error?.field === field;
	// The extra fields stay folded unless they hold a value or an error.
	const customized = $derived(
		Boolean(values.slug || values.title) || invalid('slug') || invalid('title')
	);

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
	<h2 id="create-link-heading" class="visually-hidden">Create a short link</h2>
	<input type="hidden" name="idempotencyKey" value={idempotencyKey} />
	<div class="bar">
		<div class="composer" class:invalid={invalid('destination') || invalid('domainId')}>
			<Glyph name="link" size={22} />
			<label for="link-destination" class="visually-hidden">Destination URL</label>
			<input
				id="link-destination"
				name="destination"
				type="url"
				inputmode="url"
				autocomplete="off"
				placeholder="Paste a destination URL…"
				maxlength="4096"
				required
				bind:this={destinationInput}
				value={values.destination}
				aria-invalid={invalid('destination') || undefined}
				aria-describedby={invalid('destination') ? 'link-form-error' : undefined}
			/>
			{#if showPicker}
				<span class="picker">
					<label for="link-domain" class="visually-hidden">Domain</label>
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
					<Glyph name="caretDown" size={16} />
				</span>
			{:else}
				<span class="host">{shortHost}</span>
			{/if}
		</div>
		<button type="submit" class="create" disabled={pending}
			>{pending ? 'Creating…' : 'Create link'}<Glyph name="arrowUpRight" size={20} /></button
		>
	</div>
	{#if error}<p id="link-form-error" class="error" role="alert">{error.message}</p>{/if}
	<div class="below">
		<span class="enter" aria-hidden="true"><Glyph name="returnKey" size={16} />to create</span>
		<details open={customized}>
			<summary><Glyph name="caretDown" size={18} />Customize</summary>
			<div class="custom">
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
							aria-describedby={invalid('slug')
								? 'link-form-error link-slug-hint'
								: 'link-slug-hint'}
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
						class="title-input"
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
		</details>
	</div>
</form>

<style>
	.link-form {
		display: grid;
		gap: 0.75rem;
	}
	.bar {
		display: flex;
		flex-wrap: wrap;
		gap: 0.85rem;
	}
	.composer {
		display: flex;
		flex: 1 1 26rem;
		align-items: center;
		gap: 0.85rem;
		min-width: 0;
		min-height: 3.75rem;
		padding: 0 0.5rem 0 1.15rem;
		border: 1px solid var(--color-rule);
		border-radius: var(--radius-md, 0.625rem);
		background: var(--color-input);
		color: var(--color-lead);
	}
	.composer:focus-within {
		border-color: var(--color-strong);
		box-shadow: 0 0 0 1px var(--color-strong);
	}
	.composer.invalid {
		border-color: var(--color-danger);
	}
	#link-destination {
		flex: 1;
		min-width: 0;
		align-self: stretch;
		padding: 0;
		border: 0;
		background: transparent;
		color: var(--color-strong);
		font: inherit;
		font-size: 1.0625rem;
		outline: none;
	}
	#link-destination::placeholder {
		color: var(--color-lead);
	}
	.picker,
	.host {
		position: relative;
		display: flex;
		flex: none;
		align-items: center;
		align-self: stretch;
		margin: 0.6rem 0;
		padding-left: 0.5rem;
		border-left: 1px solid var(--color-rule);
		color: var(--color-strong);
	}
	.host {
		padding: 0 1rem 0 1.5rem;
		font-size: 1.0625rem;
	}
	.picker select {
		align-self: stretch;
		max-width: 14rem;
		padding: 0 2.5rem 0 1rem;
		border: 0;
		border-radius: var(--radius-sm, 0.375rem);
		background: transparent;
		color: inherit;
		font: inherit;
		font-size: 1.0625rem;
		appearance: none;
		text-overflow: ellipsis;
	}
	.picker select:hover {
		background: var(--color-hover);
	}
	.picker select option {
		background: var(--color-paper);
		color: var(--color-strong);
	}
	.picker :global(svg) {
		position: absolute;
		right: 0.85rem;
		pointer-events: none;
	}
	.create {
		display: inline-flex;
		flex: none;
		align-items: center;
		justify-content: center;
		gap: 0.75rem;
		min-height: 3.75rem;
		padding: 0 1.75rem;
		border: 0;
		border-radius: var(--radius-md, 0.625rem);
		background: var(--color-button-primary);
		color: var(--color-on-primary);
		font: inherit;
		font-size: 1.125rem;
		font-weight: 600;
		cursor: pointer;
	}
	.create :global(svg) {
		color: var(--color-accent);
	}
	.create:hover:not(:disabled) {
		background: var(--color-button-primary-hover);
	}
	.create:disabled {
		background: var(--color-disabled);
		color: var(--color-muted);
		cursor: progress;
		opacity: 1;
	}
	.error {
		color: var(--color-danger);
		font-size: 0.9375rem;
	}
	summary {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		min-height: 2.25rem;
		color: var(--color-strong);
		font-size: 0.9375rem;
		list-style: none;
		cursor: pointer;
	}
	summary::-webkit-details-marker {
		display: none;
	}
	summary :global(svg) {
		transition: transform var(--dur-fast, 140ms) var(--ease-out, ease);
	}
	details:not([open]) summary :global(svg) {
		transform: rotate(-90deg);
	}
	.below {
		position: relative;
	}
	.enter {
		position: absolute;
		top: 0.45rem;
		right: 0;
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		color: var(--color-lead);
		font-size: 0.875rem;
		pointer-events: none;
	}
	.custom {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
		gap: 1rem 1.25rem;
		padding: 1rem 0 0.25rem;
	}
	.field {
		display: grid;
		align-content: start;
		gap: 0.4rem;
	}
	.field label {
		color: var(--color-strong);
		font-size: 0.9375rem;
		font-weight: 600;
	}
	.optional {
		color: var(--color-lead);
		font-weight: 400;
	}
	.slug {
		display: flex;
		align-items: center;
		min-height: 2.75rem;
		border: 1px solid var(--color-rule);
		border-radius: var(--radius-control, 0.5rem);
		background: var(--color-input);
		overflow: hidden;
	}
	.slug:focus-within,
	.title-input:focus {
		border-color: var(--color-strong);
		outline: 1px solid var(--color-strong);
		outline-offset: -1px;
	}
	.prefix {
		align-self: stretch;
		display: flex;
		align-items: center;
		padding: 0 0.75rem;
		border-right: 1px solid var(--color-rule);
		background: var(--color-selected);
		color: var(--color-lead);
		font-size: 0.9375rem;
		white-space: nowrap;
	}
	.slug input,
	.title-input {
		min-width: 0;
		min-height: 2.75rem;
		padding: 0 0.85rem;
		border: 0;
		background: transparent;
		color: var(--color-strong);
		font: inherit;
		font-size: 0.9375rem;
		outline: none;
	}
	.slug input {
		flex: 1;
	}
	.title-input {
		border: 1px solid var(--color-rule);
		border-radius: var(--radius-control, 0.5rem);
		background: var(--color-input);
	}
	[aria-invalid='true'] {
		color: var(--color-danger);
	}
	.hint {
		color: var(--color-lead);
		font-size: 0.875rem;
	}
	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
	@media (max-width: 40rem) {
		.create {
			width: 100%;
		}
		.enter {
			display: none;
		}
	}
</style>
