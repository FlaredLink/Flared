<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts" module>
	import type { GlyphName } from '../icons/Glyph.svelte';
	import type { PageBlockKind } from '@flared/contracts/pages';

	export const blockKinds: Record<PageBlockKind, { name: string; icon: GlyphName }> = {
		button: { name: 'Button', icon: 'link' },
		header: { name: 'Header', icon: 'textT' },
		social: { name: 'Social links', icon: 'users' },
		payment: { name: 'Payment card', icon: 'creditCard' },
		embed: { name: 'Embed', icon: 'monitorPlay' },
		signup: { name: 'Sign-up form', icon: 'envelope' }
	};
</script>

<script lang="ts">
	import { untrack } from 'svelte';
	import {
		embedProviders,
		embedSource,
		extraBlockKinds,
		maxBlockLabelLength,
		maxPaymentDescriptionLength,
		maxPriceLength,
		maxSocialLinks,
		paymentProviders,
		socialNetworks,
		type EmbedProvider,
		type PaymentProvider,
		type SocialNetwork
	} from '@flared/contracts/pages';
	import Glyph from '../icons/Glyph.svelte';
	import Button from '../atoms/Button.svelte';
	import IconButton from '../atoms/IconButton.svelte';
	import Select from '../atoms/Select.svelte';
	import TextInput from '../atoms/TextInput.svelte';
	import LinkPicker from './LinkPicker.svelte';
	import ScheduleFields from './ScheduleFields.svelte';
	import { shownNow, type DraftBlock } from './draft';

	interface Props {
		apiBase: string;
		block: DraftBlock;
		index: number;
		count: number;
		// Why the workspace cannot use payment cards and embeds, such as its plan.
		extrasUnavailable: string | null;
		// The message for a field of this block, by its API name such as "label".
		errorFor: (field: string) => string | null;
		now: number;
		onmove: (delta: -1 | 1) => void;
		onremove: () => void;
	}

	let {
		apiBase,
		block = $bindable(),
		index,
		count,
		extrasUnavailable,
		errorFor,
		now,
		onmove,
		onremove
	}: Props = $props();
	const id = $props.id();

	const hasError = $derived(
		[
			'label',
			'linkId',
			'destination',
			'links',
			'address',
			'price',
			'description',
			'buttonLabel',
			'provider',
			'startsAt',
			'endsAt'
		].some((field) => errorFor(field) !== null) ||
			(block.kind === 'social' && block.links.some((_, row) => errorFor(`links.${row}.address`)))
	);
	function untouched(item: DraftBlock): boolean {
		switch (item.kind) {
			case 'social':
				return !item.links.some((link) => link.address.trim());
			case 'embed':
				return !item.address.trim();
			default:
				return !item.label.trim();
		}
	}
	// A new block opens; a saved one opens when it has a problem.
	let open = $state(untrack(() => untouched(block)));
	$effect(() => {
		if (hasError) open = true;
	});
	let scheduling = $state(false);
	const scheduled = $derived(block.startsAt !== '' || block.endsAt !== '');

	const kind = $derived(blockKinds[block.kind]);
	const summary = $derived.by(() => {
		switch (block.kind) {
			case 'social':
				return block.links
					.filter((link) => link.address.trim())
					.map((link) => socialNetworks[link.network].name)
					.join(', ');
			case 'embed':
				return embedProviders[block.provider].name;
			default:
				return block.label;
		}
	});
	const locked = $derived(extrasUnavailable !== null && extraBlockKinds.includes(block.kind));
	const embedInvalid = $derived(
		block.kind === 'embed' &&
			block.address.trim() !== '' &&
			embedSource(block.provider, block.address.trim()) === null
	);

	const socialIds = Object.keys(socialNetworks) as SocialNetwork[];
	const paymentIds = Object.keys(paymentProviders) as PaymentProvider[];
	const embedIds = Object.keys(embedProviders) as EmbedProvider[];
</script>

<article class="block" class:invalid={hasError} aria-labelledby="{id}-title">
	<div class="head">
		<span class="handle" aria-hidden="true"><Glyph name="dots" size={18} /></span>
		<span class="mark" aria-hidden="true"><Glyph name={kind.icon} size={18} /></span>
		<button
			type="button"
			class="toggle"
			aria-expanded={open}
			aria-controls="{id}-body"
			onclick={() => (open = !open)}
		>
			<span class="title" id="{id}-title">{kind.name}</span>
			{#if summary}<span class="summary">{summary}</span>{/if}
		</button>
		{#if !shownNow(block, now)}
			<span class="flag">{block.visible ? 'Scheduled' : 'Hidden'}</span>
		{/if}
		<div class="tools">
			<IconButton
				icon="caretUp"
				label="Move {kind.name.toLowerCase()} {index + 1} up"
				size="sm"
				disabled={index === 0}
				onclick={() => onmove(-1)}
			/>
			<IconButton
				icon="caretDown"
				label="Move {kind.name.toLowerCase()} {index + 1} down"
				size="sm"
				disabled={index === count - 1}
				onclick={() => onmove(1)}
			/>
			<IconButton
				icon="trash"
				label="Remove {kind.name.toLowerCase()} {index + 1}"
				size="sm"
				onclick={onremove}
			/>
		</div>
	</div>

	<div class="body" id="{id}-body" hidden={!open}>
		{#if locked}
			<p class="note warn">{extrasUnavailable}</p>
		{/if}
		{#if !block.visible}
			<p class="note">
				This block is hidden: its link is turned off, blocked, or no longer opens the checkout.
			</p>
		{/if}

		{#if block.kind === 'payment'}
			<div class="field">
				<label for="{id}-provider">Paid with</label>
				<Select id="{id}-provider" bind:value={block.provider}>
					{#each paymentIds as provider (provider)}
						<option value={provider}>{paymentProviders[provider].name}</option>
					{/each}
				</Select>
			</div>
		{:else if block.kind === 'embed'}
			<div class="field">
				<label for="{id}-provider">Service</label>
				<Select id="{id}-provider" bind:value={block.provider}>
					{#each embedIds as provider (provider)}
						<option value={provider}>{embedProviders[provider].name}</option>
					{/each}
				</Select>
			</div>
		{/if}

		{#if block.kind === 'button' || block.kind === 'header' || block.kind === 'payment' || block.kind === 'signup'}
			<div class="field">
				<label for="{id}-label"
					>{block.kind === 'payment'
						? 'Product name'
						: block.kind === 'signup'
							? 'Heading'
							: block.kind === 'header'
								? 'Header text'
								: 'Button text'}</label
				>
				<TextInput
					id="{id}-label"
					bind:value={block.label}
					maxlength={maxBlockLabelLength}
					autocomplete="off"
					invalid={errorFor('label') !== null}
				/>
				{#if errorFor('label')}<p class="error" role="alert">{errorFor('label')}</p>{/if}
			</div>
		{/if}

		{#if block.kind === 'payment'}
			<div class="field">
				<label for="{id}-price">Price <span class="optional">optional</span></label>
				<TextInput
					id="{id}-price"
					bind:value={block.price}
					maxlength={maxPriceLength}
					placeholder="US$29"
					autocomplete="off"
					invalid={errorFor('price') !== null}
				/>
				{#if errorFor('price')}<p class="error" role="alert">{errorFor('price')}</p>{/if}
			</div>
			<div class="field">
				<label for="{id}-description">Description <span class="optional">optional</span></label>
				<TextInput
					id="{id}-description"
					bind:value={block.description}
					maxlength={maxPaymentDescriptionLength}
					autocomplete="off"
					invalid={errorFor('description') !== null}
				/>
				{#if errorFor('description')}<p class="error" role="alert">
						{errorFor('description')}
					</p>{/if}
			</div>
		{/if}

		{#if block.kind === 'button' || block.kind === 'payment'}
			<LinkPicker
				{apiBase}
				idPrefix={id}
				bind:linkId={block.linkId}
				bind:shortUrl={block.shortUrl}
				bind:destination={block.destination}
				bind:idempotencyKey={block.idempotencyKey}
				provider={block.kind === 'payment' ? block.provider : undefined}
				error={errorFor('destination') ?? errorFor('linkId')}
			/>
		{:else if block.kind === 'embed'}
			<div class="field">
				<label for="{id}-address">Address</label>
				<TextInput
					id="{id}-address"
					type="url"
					bind:value={block.address}
					placeholder="https://"
					autocomplete="off"
					spellcheck="false"
					mono
					invalid={embedInvalid || errorFor('address') !== null}
					aria-describedby="{id}-address-hint"
				/>
				<p class="hint" id="{id}-address-hint">
					Paste the address of a {embedProviders[block.provider].name} page. The page shows its player.
				</p>
				{#if errorFor('address')}
					<p class="error" role="alert">{errorFor('address')}</p>
				{:else if embedInvalid}
					<p class="error">This address cannot be embedded.</p>
				{/if}
			</div>
		{:else if block.kind === 'social'}
			<ul class="socials" aria-label="Social links">
				{#each block.links as link, row (row)}
					<li class="social">
						<Select bind:value={link.network} aria-label="Network {row + 1}">
							{#each socialIds as network (network)}
								<option value={network}>{socialNetworks[network].name}</option>
							{/each}
						</Select>
						<TextInput
							bind:value={link.address}
							type={link.network === 'email' ? 'email' : 'url'}
							placeholder={link.network === 'email'
								? 'you@example.com'
								: `https://${socialNetworks[link.network].hosts[0]}/`}
							autocomplete="off"
							spellcheck="false"
							aria-label="{socialNetworks[link.network].name} address"
							invalid={errorFor(`links.${row}.address`) !== null}
						/>
						<IconButton
							icon="x"
							label="Remove {socialNetworks[link.network].name}"
							size="sm"
							disabled={block.links.length === 1}
							onclick={() => {
								if (block.kind === 'social') block.links.splice(row, 1);
							}}
						/>
						{#if errorFor(`links.${row}.address`)}
							<p class="error row-error" role="alert">{errorFor(`links.${row}.address`)}</p>
						{/if}
					</li>
				{/each}
			</ul>
			{#if errorFor('links')}<p class="error" role="alert">{errorFor('links')}</p>{/if}
			<Button
				size="sm"
				icon="plus"
				disabled={block.links.length >= maxSocialLinks}
				onclick={() => {
					if (block.kind === 'social') block.links.push({ network: 'instagram', address: '' });
				}}>Add a social link</Button
			>
		{:else if block.kind === 'signup'}
			<div class="field">
				<label for="{id}-button">Button text</label>
				<TextInput id="{id}-button" bind:value={block.buttonLabel} maxlength={40} />
			</div>
			<p class="note">Sign-up forms do not show on pages yet.</p>
		{/if}

		{#if scheduling || scheduled}
			<ScheduleFields
				idPrefix={id}
				bind:startsAt={block.startsAt}
				bind:endsAt={block.endsAt}
				error={errorFor('endsAt') ?? errorFor('startsAt')}
			/>
			{#if scheduled}
				<Button
					size="sm"
					variant="ghost"
					onclick={() => {
						block.startsAt = '';
						block.endsAt = '';
						scheduling = false;
					}}>Remove the schedule</Button
				>
			{/if}
		{:else}
			<Button size="sm" variant="ghost" icon="clock" onclick={() => (scheduling = true)}
				>Schedule</Button
			>
		{/if}
	</div>
</article>

<style>
	.block {
		display: grid;
		gap: 0.75rem;
		padding: 0.75rem;
		border-radius: 0.875rem;
		background: var(--color-surface);
		box-shadow: var(--shadow-ring);
	}
	.block.invalid {
		box-shadow: 0 0 0 1px var(--color-danger);
	}
	.head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
	}
	.handle {
		display: none;
		color: var(--color-subtle);
		cursor: grab;
	}
	.mark {
		display: grid;
		flex: none;
		place-items: center;
		width: 2rem;
		height: 2rem;
		border-radius: 0.5rem;
		background: var(--color-surface-2);
		color: var(--color-strong);
	}
	.toggle {
		display: grid;
		flex: 1;
		min-width: 0;
		min-height: 2.75rem;
		align-content: center;
		padding: 0;
		border: 0;
		background: none;
		color: inherit;
		font: inherit;
		text-align: left;
		cursor: pointer;
	}
	.title {
		color: var(--color-strong);
		font-size: 0.9375rem;
		font-weight: 600;
	}
	.summary {
		overflow: hidden;
		color: var(--color-muted);
		font-size: 0.8125rem;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.flag {
		flex: none;
		padding: 0.125rem 0.5rem;
		border-radius: var(--radius-pill, 999px);
		background: var(--color-surface-2);
		color: var(--color-muted);
		font-size: 0.75rem;
	}
	.tools {
		display: flex;
		flex: none;
		gap: 0.125rem;
	}
	.body {
		display: grid;
		gap: 0.75rem;
	}
	.body[hidden] {
		display: none;
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
	.optional {
		color: var(--color-subtle);
		font-weight: 400;
	}
	.hint,
	.note {
		color: var(--color-lead);
		font-size: 0.8125rem;
	}
	.note.warn {
		color: var(--color-warning);
	}
	.error {
		color: var(--color-danger);
		font-size: 0.875rem;
	}
	.socials {
		display: grid;
		gap: 0.5rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.social {
		display: grid;
		grid-template-columns: minmax(0, 9rem) minmax(0, 1fr) auto;
		gap: 0.375rem;
		align-items: center;
	}
	.row-error {
		grid-column: 1 / -1;
	}
	@media (pointer: fine) {
		.handle {
			display: block;
		}
	}
</style>
