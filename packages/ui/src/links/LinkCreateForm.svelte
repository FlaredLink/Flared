<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts" module>
	export interface LinkFormValues {
		destination: string;
		slug: string;
		title: string;
	}
</script>

<script lang="ts">
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
	}

	let {
		action,
		idempotencyKey,
		shortHost,
		values = { destination: '', slug: '', title: '' },
		error = null,
		pending = false,
		enhance = () => {}
	}: Props = $props();

	const invalid = (field: string) => error?.field === field;
</script>

<form method="post" {action} class="link-form" use:enhance aria-labelledby="create-link-heading">
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
	<div class="row">
		<div class="field">
			<label for="link-slug">Slug <span class="optional">optional</span></label>
			<div class="slug">
				<span class="prefix" aria-hidden="true">{shortHost}/</span>
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
	input {
		width: 100%;
		min-width: 0;
		min-height: 44px;
		padding: 0.6rem 0.8rem;
		color: var(--color-ink, #101828);
		border: 1px solid var(--color-rule, #d0d5dd);
		border-radius: var(--radius-sm, 6px);
		background: var(--color-paper, #fff);
	}
	input:focus-visible {
		border-color: var(--color-muted, #667085);
		outline: 1px solid var(--color-muted, #667085);
		outline-offset: -1px;
	}
	input[aria-invalid='true'] {
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
