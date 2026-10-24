<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import type { Link } from '@flared/contracts/links';
	import {
		isPaymentDestination,
		paymentProviders,
		type PaymentProvider
	} from '@flared/contracts/pages';
	import Button from '../atoms/Button.svelte';
	import TextInput from '../atoms/TextInput.svelte';
	import SegmentedControl from '../molecules/SegmentedControl.svelte';
	import { shownWorkspace } from '../workspace/shown';
	import { searchLinks } from './client';
	import { newKey } from './draft';

	interface Props {
		apiBase: string;
		idPrefix: string;
		linkId: string | null;
		shortUrl: string | null;
		destination: string;
		idempotencyKey: string;
		// A payment card accepts only links to this provider's checkout.
		provider?: PaymentProvider;
		error?: string | null;
	}

	let {
		apiBase,
		idPrefix,
		linkId = $bindable(),
		shortUrl = $bindable(),
		destination = $bindable(),
		idempotencyKey = $bindable(),
		provider,
		error = null
	}: Props = $props();
	const workspace = shownWorkspace();

	let changing = $state(false);
	// The link before Change, so Keep can bring it back after a destination was typed.
	let previous = { linkId: null as string | null, shortUrl: null as string | null };
	let mode = $state('new');
	let search = $state('');
	let results = $state<Link[] | null>(null);
	let searchError = $state('');

	const checkout = $derived(provider ? paymentProviders[provider] : null);
	const wrongHost = $derived(
		provider !== undefined &&
			destination.trim() !== '' &&
			URL.canParse(destination.trim()) &&
			!isPaymentDestination(provider, destination.trim())
	);

	$effect(() => {
		if (mode !== 'existing' || (linkId !== null && !changing)) return;
		const text = search;
		const timer = setTimeout(async () => {
			const result = await searchLinks(apiBase, text, workspace());
			if (text !== search) return;
			results = result.ok ? result.value : null;
			searchError = result.ok ? '' : 'Links could not load. Try again.';
		}, 300);
		return () => clearTimeout(timer);
	});

	function startChange() {
		previous = { linkId, shortUrl };
		changing = true;
	}

	function keep() {
		linkId = previous.linkId;
		shortUrl = previous.shortUrl;
		destination = '';
		changing = false;
	}

	function choose(link: Link) {
		linkId = link.id;
		shortUrl = link.shortUrl;
		destination = '';
		changing = false;
	}

	function typed(value: string) {
		// The key belongs to one destination; the API refuses a key sent again with another body.
		idempotencyKey = newKey();
		destination = value;
		if (changing) {
			linkId = null;
			shortUrl = null;
		}
	}

	const allowed = (link: Link) =>
		provider === undefined || isPaymentDestination(provider, link.destination);
</script>

<div class="picker">
	{#if linkId !== null && !changing}
		<p class="current">
			<span class="label">Opens</span>
			<a href={shortUrl} target="_blank" rel="noopener noreferrer">{shortUrl}</a>
			<Button size="sm" variant="ghost" onclick={startChange}>Change</Button>
		</p>
	{:else}
		<SegmentedControl
			options={[
				{ value: 'new', label: 'New link' },
				{ value: 'existing', label: 'Existing link' }
			]}
			bind:value={mode}
			name="{idPrefix}-link-mode"
			label="Link"
		/>
		{#if mode === 'new'}
			<div class="field">
				<label for="{idPrefix}-destination">Destination</label>
				<TextInput
					id="{idPrefix}-destination"
					type="url"
					value={destination}
					oninput={(event) => typed(event.currentTarget.value)}
					placeholder={checkout
						? `https://${checkout.hosts[0].replace('*.', 'store.')}/…`
						: 'https://'}
					autocomplete="off"
					spellcheck="false"
					mono
					invalid={error !== null || wrongHost}
					aria-describedby="{idPrefix}-destination-hint"
				/>
				<p class="hint" id="{idPrefix}-destination-hint">
					{#if checkout}
						Paste your {checkout.name} checkout link. Save makes a short link for it.
					{:else}
						Save makes a short link for it, so its clicks count on this page.
					{/if}
				</p>
				{#if wrongHost && checkout}
					<p class="error">
						Use a {checkout.name} checkout address ({checkout.hosts.join(' or ')}).
					</p>
				{/if}
			</div>
		{:else}
			<div class="field">
				<label for="{idPrefix}-search">Search your links</label>
				<TextInput
					id="{idPrefix}-search"
					type="search"
					icon="search"
					bind:value={search}
					autocomplete="off"
					placeholder="Title, slug, or destination"
				/>
				{#if searchError}<p class="error" role="alert">{searchError}</p>{/if}
				{#if results !== null}
					{#if results.length === 0}
						<p class="hint">No links match.</p>
					{:else}
						<ul class="results" aria-label="Links">
							{#each results as link (link.id)}
								<li>
									<button
										type="button"
										class="result"
										disabled={!allowed(link)}
										onclick={() => choose(link)}
									>
										<span class="title">{link.title ?? `${link.hostname}/${link.slug}`}</span>
										<span class="meta">{link.hostname}/{link.slug} · {link.destination}</span>
										{#if !allowed(link) && checkout}
											<span class="meta">Not a {checkout.name} checkout link</span>
										{/if}
									</button>
								</li>
							{/each}
						</ul>
					{/if}
				{/if}
			</div>
		{/if}
		{#if changing}
			<Button size="sm" variant="ghost" onclick={keep}>Keep the current link</Button>
		{/if}
	{/if}
	{#if error}<p class="error" role="alert">{error}</p>{/if}
</div>

<style>
	.picker {
		display: grid;
		gap: 0.5rem;
		min-width: 0;
	}
	.current {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem 0.5rem;
		min-width: 0;
		font-size: 0.875rem;
	}
	.current .label {
		color: var(--color-subtle);
	}
	.current a {
		min-width: 0;
		color: var(--color-link);
		font-family: var(--font-mono);
		overflow-wrap: anywhere;
		text-decoration: underline;
		text-underline-offset: 3px;
	}
	.field {
		display: grid;
		gap: 0.25rem;
	}
	label {
		color: var(--color-strong);
		font-size: 0.875rem;
		font-weight: 500;
	}
	.hint {
		color: var(--color-lead);
		font-size: 0.8125rem;
	}
	.error {
		color: var(--color-danger);
		font-size: 0.875rem;
	}
	.results {
		display: grid;
		gap: 0.25rem;
		max-height: 15rem;
		margin: 0.25rem 0 0;
		padding: 0;
		overflow-y: auto;
		list-style: none;
	}
	.result {
		display: grid;
		gap: 0.125rem;
		width: 100%;
		min-height: 2.75rem;
		padding: 0.5rem 0.625rem;
		border: 0;
		border-radius: var(--radius-control, 0.5rem);
		background: none;
		color: inherit;
		font: inherit;
		text-align: left;
		cursor: pointer;
	}
	.result:hover:not(:disabled) {
		background: var(--color-hover);
	}
	.result:disabled {
		cursor: not-allowed;
		opacity: 0.6;
	}
	.title {
		color: var(--color-strong);
		font-size: 0.875rem;
		font-weight: 500;
	}
	.meta {
		overflow: hidden;
		color: var(--color-subtle);
		font-size: 0.75rem;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
