<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts" module>
	export interface LinkFormValues {
		destination: string;
		slug: string;
		title: string;
		// Empty or absent means the installation default.
		domainId?: string;
		// Empty or absent means no device destination.
		iosDestination?: string;
		androidDestination?: string;
		// ISO 8601 times and a URL; empty or absent means none. A password is never sent back.
		startsAt?: string;
		endsAt?: string;
		endedDestination?: string;
		// Empty or absent means the destination's own. An image is never sent back.
		previewTitle?: string;
		previewDescription?: string;
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
	import Button from '../atoms/Button.svelte';
	import { utmOf } from '@flared/contracts/links';
	import AccessFields from './AccessFields.svelte';
	import DeviceFields from './DeviceFields.svelte';
	import PreviewFields from './PreviewFields.svelte';
	import UtmFields from './UtmFields.svelte';

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
		// Why the workspace cannot set dates or a password, such as its plan. Without it, it can.
		accessUnavailable?: string | null;
		// Why the workspace cannot set a link card, such as its plan. Without it, it can.
		previewUnavailable?: string | null;
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
		destinationInput = $bindable(),
		accessUnavailable = null,
		previewUnavailable = null
	}: Props = $props();

	const invalid = (field: string) => error?.field === field;
	// The extra fields stay folded unless they hold a value or an error. Without script they
	// stay open, so the form works before hydration too.
	const customized = $derived(
		Boolean(
			values.title ||
			values.iosDestination ||
			values.androidDestination ||
			values.startsAt ||
			values.endsAt ||
			values.endedDestination ||
			values.previewTitle ||
			values.previewDescription
		) ||
			Object.keys(utmOf(values.destination)).length > 0 ||
			[
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
			].some(invalid)
	);
	// Bound to the destination field, so the UTM fields can write into it.
	let destination = $state(untrack(() => values.destination));
	$effect(() => {
		destination = values.destination;
	});
	let mounted = $state(false);
	let customOpen = $state(untrack(() => customized));
	$effect(() => {
		if (customized) customOpen = true;
	});
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
		destination = '';
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
	enctype="multipart/form-data"
	class="link-form"
	use:enhance
	onsubmit={remember}
	onreset={restoreAfterReset}
	aria-labelledby="create-link-heading"
>
	<h2 id="create-link-heading" class="visually-hidden">Create a short link</h2>
	<input type="hidden" name="idempotencyKey" value={idempotencyKey} />
	<ShownWorkspaceField />
	<div class="field">
		<label for="link-destination">Destination</label>
		<div class="input" class:invalid={invalid('destination')}>
			<input
				id="link-destination"
				name="destination"
				type="url"
				inputmode="url"
				autocomplete="off"
				autocapitalize="off"
				spellcheck="false"
				enterkeyhint="go"
				placeholder="https://"
				maxlength="4096"
				required
				bind:this={destinationInput}
				bind:value={destination}
				aria-invalid={invalid('destination') || undefined}
				aria-describedby={invalid('destination') ? 'link-form-error' : undefined}
			/>
		</div>
	</div>
	<div class="field">
		<label for="link-slug">Short link</label>
		<!-- The domain and the ending, as the short link will read. The ending cannot change later. -->
		<div class="input short" class:invalid={invalid('slug') || invalid('domainId')}>
			{#if showPicker}<span class="picker">
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
					<Glyph name="caretUpDown" size={14} />
				</span>{:else}<span class="host">{shortHost}</span>{/if}<span
				class="slash"
				aria-hidden="true">/</span
			>
			<input
				id="link-slug"
				name="slug"
				type="text"
				autocomplete="off"
				autocapitalize="off"
				autocorrect="off"
				spellcheck="false"
				enterkeyhint="go"
				placeholder="random ending"
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
			Optional. Leave the ending empty for a random one. It cannot change after you create the link.
		</p>
	</div>
	{#if mounted}
		<button
			type="button"
			class="toggle"
			aria-expanded={customOpen}
			aria-controls="link-custom"
			onclick={() => (customOpen = !customOpen)}
			><Glyph name="caretDown" size={18} />More options</button
		>
	{/if}
	<div class="custom" id="link-custom" hidden={mounted && !customOpen}>
		<div class="field">
			<label for="link-title">Title <span class="optional">optional</span></label>
			<div class="input" class:invalid={invalid('title')}>
				<input
					id="link-title"
					name="title"
					type="text"
					autocomplete="off"
					enterkeyhint="go"
					maxlength="200"
					placeholder="Spring launch"
					value={values.title}
					aria-invalid={invalid('title') || undefined}
					aria-describedby={invalid('title') ? 'link-form-error' : undefined}
				/>
			</div>
		</div>
		<UtmFields bind:destination idPrefix="link" />
		<DeviceFields
			idPrefix="link"
			values={{
				iosDestination: values.iosDestination ?? '',
				androidDestination: values.androidDestination ?? ''
			}}
			{error}
			errorId="link-form-error"
		/>
		<AccessFields
			idPrefix="link"
			values={{
				startsAt: values.startsAt ?? '',
				endsAt: values.endsAt ?? '',
				endedDestination: values.endedDestination ?? ''
			}}
			{error}
			errorId="link-form-error"
			unavailable={accessUnavailable}
		/>
		<PreviewFields
			idPrefix="link"
			values={{
				previewTitle: values.previewTitle ?? '',
				previewDescription: values.previewDescription ?? ''
			}}
			{error}
			errorId="link-form-error"
			unavailable={previewUnavailable}
		/>
	</div>
	{#if error}<p id="link-form-error" class="error" role="alert">{error.message}</p>{/if}
	<Button type="submit" variant="primary" size="lg" wide disabled={pending}
		>{pending ? 'Creating…' : 'Create link'}</Button
	>
</form>

<style>
	/* One column for a dialog, a phone sheet, and a page: each field is a label over its box. */
	.link-form {
		display: grid;
		gap: 1rem;
		min-width: 0;
	}
	.field {
		display: grid;
		gap: 0.375rem;
		min-width: 0;
	}
	label {
		color: var(--color-muted);
		font-size: 0.875rem;
		font-weight: 500;
	}
	.optional {
		color: var(--color-subtle);
		font-weight: 400;
	}
	.input {
		display: flex;
		align-items: center;
		min-width: 0;
		min-height: 3.125rem;
		padding: 0 0.875rem;
		border-radius: 0.75rem;
		background: var(--color-surface-2);
		box-shadow: var(--shadow-ring);
	}
	.input:focus-within {
		box-shadow: 0 0 0 2px var(--color-focus);
	}
	.input.invalid {
		box-shadow: 0 0 0 1px var(--color-danger);
	}
	.input input {
		flex: 1;
		min-width: 0;
		align-self: stretch;
		padding: 0;
		border: 0;
		background: transparent;
		color: var(--color-strong);
		font: inherit;
		/* 16px, so iOS does not zoom into the field. */
		font-size: 1rem;
		outline: none;
	}
	.input input::placeholder {
		color: var(--color-subtle);
	}
	[aria-invalid='true'] {
		color: var(--color-danger);
	}
	.host {
		flex: none;
		max-width: 60%;
		overflow: hidden;
		color: var(--color-muted);
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.slash {
		flex: none;
		margin: 0 0.125rem;
		color: var(--color-subtle);
	}
	/* The domain is a choice only when there is more than one; then it reads as part of the link. */
	.picker {
		position: relative;
		display: inline-flex;
		flex: 0 1 auto;
		align-items: center;
		align-self: stretch;
		min-width: 0;
		max-width: 60%;
		color: var(--color-muted);
	}
	.picker select {
		width: 100%;
		min-width: 0;
		padding: 0 1.25rem 0 0;
		border: 0;
		background: transparent;
		color: inherit;
		font: inherit;
		font-size: 1rem;
		text-overflow: ellipsis;
		appearance: none;
		outline: none;
		cursor: pointer;
	}
	.picker select option {
		background: var(--color-paper);
		color: var(--color-strong);
	}
	.picker :global(svg) {
		position: absolute;
		right: 0;
		pointer-events: none;
	}
	.hint {
		color: var(--color-subtle);
		font-size: 0.8125rem;
	}
	.toggle {
		display: inline-flex;
		justify-self: start;
		align-items: center;
		gap: 0.5rem;
		min-height: 2.75rem;
		margin: -0.25rem 0 -0.25rem -0.5rem;
		padding: 0 0.5rem;
		border: 0;
		border-radius: var(--radius-control, 0.5rem);
		background: none;
		color: var(--color-strong);
		font: inherit;
		font-size: 0.9375rem;
		font-weight: 500;
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
		gap: 1.25rem;
		min-width: 0;
	}
	.custom[hidden] {
		display: none;
	}
	.error {
		color: var(--color-danger);
		font-size: 0.9375rem;
	}
	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
	@media (min-width: 48rem) {
		.input {
			min-height: 2.75rem;
			border-radius: 0.5625rem;
		}
		.input input,
		.picker select {
			font-size: 0.9375rem;
		}
	}
</style>
