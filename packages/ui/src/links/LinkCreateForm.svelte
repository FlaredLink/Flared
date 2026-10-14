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
	import ShownWorkspaceField from '../workspace/ShownWorkspaceField.svelte';
	import { onMount, untrack } from 'svelte';
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
	// The extra fields stay folded unless they hold a value or an error. Without script they
	// stay open, so the form works before hydration too.
	const customized = $derived(
		Boolean(values.slug || values.title) || invalid('slug') || invalid('title')
	);
	let mounted = $state(false);
	let customOpen = $state(untrack(() => customized));
	$effect(() => {
		if (customized) customOpen = true;
	});
	// The preview shows the short link before it exists, since its ending cannot change later.
	let ending = $state(untrack(() => values.slug));

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
		mounted = true;
	});

	// A successful create resets the form; keep the domain that was just used.
	function restoreAfterReset() {
		ending = '';
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
	<ShownWorkspaceField />
	<label for="link-destination" class="destination-label">Destination URL</label>
	<div class="bar">
		<div class="composer" class:invalid={invalid('destination')}>
			<Glyph name="link" size={22} />
			<input
				id="link-destination"
				name="destination"
				type="url"
				inputmode="url"
				autocomplete="off"
				placeholder="https://example.com/page"
				maxlength="4096"
				required
				bind:this={destinationInput}
				value={values.destination}
				aria-invalid={invalid('destination') || undefined}
				aria-describedby={invalid('destination') ? 'link-form-error' : undefined}
			/>
		</div>
		<button type="submit" class="create" disabled={pending}
			>{pending ? 'Creating…' : 'Create link'}<span class="enter" title="Press Enter to create"
				><Glyph name="returnKey" size={18} /></span
			></button
		>
	</div>
	{#if error}<p id="link-form-error" class="error" role="alert">{error.message}</p>{/if}
	<div class="below">
		<p class="preview">
			<span class="preview-label">Short link</span>
			<span class="address"
				>{#if showPicker}<span class="picker" class:invalid={invalid('domainId')}>
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
						<Glyph name="caretDown" size={14} />
					</span>{:else}<span class="host">{shortHost}</span>{/if}/{#if ending}<strong
						>{ending}</strong
					>{:else}<em>random ending</em>{/if}</span
			>
		</p>
		{#if mounted}
			<button
				type="button"
				class="toggle"
				aria-expanded={customOpen}
				aria-controls="link-custom"
				onclick={() => (customOpen = !customOpen)}
				><Glyph name="caretDown" size={18} />Custom ending and title</button
			>
		{/if}
	</div>
	<div class="custom" id="link-custom" hidden={mounted && !customOpen}>
		<div class="custom-field">
			<label for="link-slug">Custom ending <span class="optional">optional</span></label>
			<div class="slug">
				<span class="prefix" aria-hidden="true">{previewHost}/</span>
				<input
					id="link-slug"
					name="slug"
					type="text"
					autocomplete="off"
					autocapitalize="none"
					spellcheck="false"
					placeholder="spring-sale"
					minlength="3"
					maxlength="64"
					pattern="[a-z0-9]([a-z0-9\-]*[a-z0-9])?"
					title="3 to 64 lowercase letters, digits, or hyphens"
					bind:value={ending}
					aria-invalid={invalid('slug') || undefined}
					aria-describedby={invalid('slug') ? 'link-form-error link-slug-hint' : 'link-slug-hint'}
				/>
			</div>
			<p id="link-slug-hint" class="hint">
				Leave empty for a random ending. The ending cannot change after you create the link.
			</p>
		</div>
		<div class="custom-field">
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
</form>

<style>
	.link-form {
		display: grid;
		gap: 0.6rem;
	}
	.destination-label {
		color: var(--color-strong);
		font-size: 0.9375rem;
		font-weight: 600;
	}
	.bar {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
	}
	.composer {
		display: flex;
		flex: 1 1 22rem;
		align-items: center;
		gap: 0.85rem;
		min-width: 0;
		min-height: 3.5rem;
		padding: 0 1rem 0 1.15rem;
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
	.create {
		display: inline-flex;
		flex: none;
		align-items: center;
		justify-content: center;
		gap: 0.75rem;
		min-height: 3.5rem;
		padding: 0 1.25rem 0 1.5rem;
		border: 0;
		border-radius: var(--radius-md, 0.625rem);
		background: var(--color-button-primary);
		color: var(--color-on-primary);
		font: inherit;
		font-size: 1.0625rem;
		font-weight: 600;
		cursor: pointer;
	}
	/* The Enter key the create button answers to, as a key cap. */
	.enter {
		display: inline-grid;
		place-items: center;
		width: 1.75rem;
		height: 1.75rem;
		border: 1px solid color-mix(in oklab, currentColor 35%, transparent);
		border-radius: var(--radius-sm, 0.375rem);
		opacity: 0.8;
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
	.below {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.25rem 1rem;
	}
	.preview {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem 0.6rem;
		min-width: 0;
		color: var(--color-lead);
		font-size: 0.9375rem;
	}
	.preview-label {
		color: var(--color-lead);
	}
	.address {
		display: inline-flex;
		align-items: center;
		min-width: 0;
		overflow-wrap: anywhere;
		color: var(--color-strong);
	}
	.address strong {
		font-weight: 600;
	}
	.address em {
		color: var(--color-lead);
		font-style: italic;
	}
	.host {
		color: var(--color-strong);
	}
	/* The domain is a choice only when there is more than one; then it looks like one. */
	.picker {
		position: relative;
		display: inline-flex;
		align-items: center;
		margin-right: 0.15rem;
	}
	.picker select {
		min-height: 2.25rem;
		max-width: 14rem;
		padding: 0 1.9rem 0 0.6rem;
		border: 1px solid var(--color-rule);
		border-radius: var(--radius-control, 0.5rem);
		background: var(--color-input);
		color: var(--color-strong);
		font: inherit;
		font-size: 0.9375rem;
		appearance: none;
		text-overflow: ellipsis;
		cursor: pointer;
	}
	.picker.invalid select {
		border-color: var(--color-danger);
	}
	.picker select:hover {
		border-color: var(--color-strong);
	}
	.picker select option {
		background: var(--color-paper);
		color: var(--color-strong);
	}
	.picker :global(svg) {
		position: absolute;
		right: 0.55rem;
		pointer-events: none;
	}
	.toggle {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		min-height: 2.25rem;
		padding: 0 0.5rem;
		margin-right: -0.5rem;
		border: 0;
		border-radius: var(--radius-control, 0.5rem);
		background: none;
		color: var(--color-strong);
		font: inherit;
		font-size: 0.9375rem;
		cursor: pointer;
	}
	.toggle:hover {
		background: var(--color-hover);
	}
	.toggle :global(svg) {
		transition: transform var(--dur-fast, 140ms) var(--ease-out, ease);
	}
	.toggle[aria-expanded='false'] :global(svg) {
		transform: rotate(-90deg);
	}
	.custom {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
		gap: 1.25rem 1.5rem;
		padding: 0.5rem 0;
	}
	.custom[hidden] {
		display: none;
	}
	.custom-field {
		display: grid;
		align-content: start;
		gap: 0.4rem;
	}
	.custom-field label {
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
		font-size: 1rem;
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
	/* Touch screens have no Enter key beside the field. */
	@media (pointer: coarse) {
		.enter {
			display: none;
		}
	}
</style>
