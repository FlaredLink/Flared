<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import Glyph from '../icons/Glyph.svelte';
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
		oncancel?: () => void;
		input?: HTMLInputElement;
		// Centred under the empty-state headline, or left-aligned in a card.
		centered?: boolean;
	}
	let {
		subdomain = $bindable(),
		domain = $bindable(),
		error,
		errorField = null,
		pending,
		disabled,
		onsubmit,
		oncancel,
		input = $bindable(),
		centered = false
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
	class:centered
	novalidate
	onsubmit={(event) => {
		event.preventDefault();
		onsubmit();
	}}
>
	<div class="row">
		<div class="group subdomain" class:invalid={invalidSubdomain}>
			<label for="domain-subdomain">Subdomain</label>
			<input
				id="domain-subdomain"
				bind:this={input}
				bind:value={subdomain}
				type="text"
				autocomplete="off"
				autocapitalize="none"
				spellcheck="false"
				maxlength="63"
				placeholder="go"
				required
				aria-invalid={invalidSubdomain || undefined}
				aria-describedby={described(invalidSubdomain)}
			/>
		</div>
		<div class="group domain" class:invalid={invalidDomain}>
			<label for="domain-domain">Domain</label>
			<input
				id="domain-domain"
				bind:value={domain}
				type="text"
				inputmode="url"
				autocomplete="off"
				autocapitalize="none"
				spellcheck="false"
				maxlength="253"
				placeholder="yourbrand.com"
				required
				aria-invalid={invalidDomain || undefined}
				aria-describedby={described(invalidDomain)}
			/>
		</div>
		<button type="submit" class="submit" disabled={disabled || pending}
			>{pending ? 'Adding…' : 'Add domain'}<Glyph name="arrowUpRight" size={18} /></button
		>
		{#if oncancel}<Button variant="ghost" disabled={pending} onclick={oncancel}>Cancel</Button>{/if}
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
	}
	.centered {
		justify-items: center;
		text-align: center;
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
		width: min(100%, 48rem);
	}
	.group {
		display: flex;
		flex: 1 1 13rem;
		min-width: 0;
		min-height: 3rem;
		border: 1px solid var(--color-rule);
		border-radius: var(--radius-control, 0.5rem);
		background: var(--color-input);
		overflow: hidden;
	}
	.group.domain {
		flex: 1.4 1 16rem;
	}
	.group:focus-within {
		border-color: var(--color-strong);
		box-shadow: 0 0 0 1px var(--color-strong);
	}
	.group.invalid {
		border-color: var(--color-danger);
	}
	label {
		display: flex;
		align-items: center;
		padding: 0 1rem;
		border-right: 1px solid var(--color-rule);
		color: var(--color-strong);
		font-size: 0.9375rem;
		font-weight: 500;
		white-space: nowrap;
	}
	input {
		flex: 1;
		min-width: 0;
		padding: 0 1rem;
		border: 0;
		background: transparent;
		color: var(--color-strong);
		font: inherit;
		font-size: 0.9375rem;
		outline: none;
	}
	input::placeholder {
		color: var(--color-lead);
	}
	.submit {
		display: inline-flex;
		flex: none;
		align-items: center;
		justify-content: center;
		gap: 0.6rem;
		min-height: 3rem;
		padding: 0 1.4rem;
		border: 0;
		border-radius: var(--radius-control, 0.5rem);
		background: var(--color-button-primary);
		color: var(--color-on-primary);
		font: inherit;
		font-size: 1rem;
		font-weight: 600;
		cursor: pointer;
	}
	.submit :global(svg) {
		color: var(--color-accent);
	}
	.submit:hover:not(:disabled) {
		background: var(--color-button-primary-hover);
	}
	.submit:disabled {
		background: var(--color-disabled);
		color: var(--color-muted);
		cursor: not-allowed;
		opacity: 1;
	}
	.submit:disabled :global(svg) {
		color: inherit;
	}
	.hint {
		color: var(--color-lead);
		font-size: 0.875rem;
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
	@media (max-width: 30rem) {
		.submit {
			width: 100%;
		}
	}
</style>
