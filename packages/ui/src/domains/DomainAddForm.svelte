<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import Button from '../atoms/Button.svelte';

	interface Props {
		subdomain: string;
		domain: string;
		error: string;
		// The field the error is about; null marks both, as for a hostname the server refused.
		errorField?: 'subdomain' | 'domain' | null;
		pending: boolean;
		disabled: boolean;
		onsubmit: () => void;
		input?: HTMLInputElement;
	}
	let {
		subdomain = $bindable(),
		domain = $bindable(),
		error,
		errorField = null,
		pending,
		disabled,
		onsubmit,
		input = $bindable()
	}: Props = $props();
	const invalidSubdomain = $derived(Boolean(error) && errorField !== 'domain');
	const invalidDomain = $derived(Boolean(error) && errorField !== 'subdomain');
	const described = (invalid: boolean) =>
		invalid ? 'domain-hostname-error domain-hostname-hint' : 'domain-hostname-hint';
	const preview = $derived(
		subdomain.trim() && domain.trim()
			? `${subdomain.trim().toLowerCase()}.${domain.trim().toLowerCase()}`
			: ''
	);
</script>

<form
	class="add"
	novalidate
	onsubmit={(event) => {
		event.preventDefault();
		onsubmit();
	}}
>
	<div class="row">
		<div class="group" class:invalid={invalidSubdomain}>
			<label for="domain-subdomain">Subdomain</label>
			<input
				id="domain-subdomain"
				bind:this={input}
				bind:value={subdomain}
				type="text"
				autocomplete="off"
				autocapitalize="none"
				spellcheck="false"
				enterkeyhint="next"
				maxlength="63"
				placeholder="go"
				required
				aria-invalid={invalidSubdomain || undefined}
				aria-describedby={described(invalidSubdomain)}
			/>
		</div>
		<div class="group" class:invalid={invalidDomain}>
			<label for="domain-domain">Domain</label>
			<input
				id="domain-domain"
				bind:value={domain}
				type="text"
				inputmode="url"
				autocomplete="off"
				autocapitalize="none"
				spellcheck="false"
				enterkeyhint="done"
				maxlength="253"
				placeholder="yourbrand.com"
				required
				aria-invalid={invalidDomain || undefined}
				aria-describedby={described(invalidDomain)}
			/>
		</div>
		<span class="submit"
			><Button type="submit" variant="primary" wide disabled={disabled || pending}
				>{pending ? 'Adding…' : 'Add domain'}</Button
			></span
		>
	</div>
	{#if error}<p id="domain-hostname-error" class="error" role="alert">{error}</p>{/if}
	<p id="domain-hostname-hint" class="hint">
		{#if preview}Your links will start with <strong>{preview}/</strong>.{:else}For example,
			go.yourbrand.com or links.yourbrand.com.{/if}<br />You need access to your domain’s DNS
		settings.
	</p>
</form>

<style>
	.add {
		display: grid;
		gap: 0.75rem;
		container-type: inline-size;
	}
	/* Base: the fields and the button stack. A wide form puts them on one row. */
	.row {
		display: grid;
		gap: 0.625rem;
	}
	.group {
		display: flex;
		min-width: 0;
		min-height: 2.75rem;
		border-radius: var(--radius-control, 0.5rem);
		background: var(--color-surface-2);
		box-shadow: var(--shadow-ring);
		overflow: hidden;
	}
	.group:focus-within {
		box-shadow: 0 0 0 2px var(--color-focus);
	}
	.group.invalid {
		box-shadow: 0 0 0 1px var(--color-danger);
	}
	label {
		display: flex;
		flex: none;
		align-items: center;
		width: 6.5rem;
		padding: 0 0.875rem;
		color: var(--color-muted);
		font-size: 0.875rem;
		font-weight: 500;
		white-space: nowrap;
	}
	input {
		flex: 1;
		min-width: 0;
		padding: 0 0.875rem 0 0;
		border: 0;
		background: transparent;
		color: var(--color-strong);
		font: inherit;
		/* 16px on phones, so iOS does not zoom into the field. */
		font-size: 1rem;
		outline: none;
	}
	input::placeholder {
		color: var(--color-subtle);
	}
	.submit {
		display: flex;
	}
	.hint {
		color: var(--color-subtle);
		font-size: 0.8125rem;
		line-height: 1.55;
		overflow-wrap: anywhere;
	}
	.hint strong {
		color: var(--color-strong);
		font-weight: 600;
	}
	.error {
		color: var(--color-danger);
		font-size: 0.875rem;
	}
	@media (min-width: 48rem) {
		input {
			font-size: 0.9375rem;
		}
	}
	@container (min-width: 36rem) {
		.row {
			grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr) auto;
		}
		label {
			width: auto;
		}
	}
</style>
