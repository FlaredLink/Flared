<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts" module>
	// One view of the link page, such as Analytics or QR code. Each view has its own address.
	export interface LinkView {
		label: string;
		href: string;
		current: boolean;
	}
</script>

<script lang="ts">
	import ShownWorkspaceField from '../workspace/ShownWorkspaceField.svelte';
	import type { Action } from 'svelte/action';
	import type { Link } from '@flared/contracts/links';
	import Glyph from '../icons/Glyph.svelte';
	import Button from '../atoms/Button.svelte';
	import StatusDot from '../atoms/StatusDot.svelte';
	import type { Crumb } from '../molecules/Breadcrumbs.svelte';
	import CopyButton from '../molecules/CopyButton.svelte';
	import Menu, { type MenuItem } from '../molecules/Menu.svelte';
	import Callout from '../molecules/Callout.svelte';
	import PageHeader from '../molecules/PageHeader.svelte';
	import { blockLabel } from './messages';

	interface Props {
		link: Link;
		// The trail to this page, ending with the link.
		crumbs: Crumb[];
		// The link list, for the phone back button.
		backHref: string;
		views?: LinkView[];
		// Form action URL for disable and enable. The app wrapper sends PATCH /v1/links/:id.
		action: string;
		enhance?: Action<HTMLFormElement>;
		pending?: boolean;
		// A short confirmation after a change, such as "Saved."
		notice?: string;
		// An error from disable or enable; edit errors show in the edit form.
		error?: string | null;
		// Opens the edit form. Without it, the header shows no Edit button.
		onedit?: () => void;
	}
	let {
		link,
		crumbs,
		backHref,
		views = [],
		action,
		enhance = () => {},
		pending = false,
		notice = '',
		error = null,
		onedit
	}: Props = $props();

	const shortName = $derived(`${link.hostname}/${link.slug}`);
	let toggleForm = $state<HTMLFormElement>();

	const moreItems = $derived<MenuItem[]>([
		...(link.blocked
			? []
			: [
					{
						label: link.enabled ? 'Disable link' : 'Enable link',
						icon: link.enabled ? ('pause' as const) : ('play' as const),
						danger: link.enabled,
						disabled: pending,
						onselect: () => toggleForm?.requestSubmit()
					}
				]),
		{ label: 'Open short link', icon: 'arrowUpRight', href: link.shortUrl, external: true },
		{ label: 'Open destination', icon: 'external', href: link.destination, external: true }
	]);
</script>

<!-- The views are tabs of one screen, so a switch replaces the history entry and back still
     leads to the link list. -->
{#snippet viewLinks(placement: 'bar' | 'under')}
	<nav class="views {placement}" aria-label="Link views">
		{#each views as view (view.href)}
			<a
				href={view.href}
				aria-current={view.current ? 'page' : undefined}
				data-sveltekit-replacestate
				data-sveltekit-noscroll
				data-sveltekit-keepfocus>{view.label}</a
			>
		{/each}
	</nav>
{/snippet}

<PageHeader {crumbs} back={{ href: backHref, label: 'Links' }} title={link.title ?? shortName}>
	{#snippet top(placement)}
		{#if placement === 'bar' && views.length > 0}{@render viewLinks('bar')}{/if}
	{/snippet}
	{#snippet aside()}
		{#if onedit && !link.blocked}
			<Button size="sm" icon="pencil" onclick={onedit}><span class="wide-label">Edit</span></Button>
		{/if}
		<Menu id="link-more-menu" label="More actions for {shortName}" items={moreItems} />
	{/snippet}
	<div class="summary">
		<p class="short">
			<a href={link.shortUrl} target="_blank" rel="noopener noreferrer"
				><span class="host">{link.hostname}/</span>{link.slug}</a
			>
			<CopyButton text={link.shortUrl} label="Copy short link" size="sm" />
		</p>
		<a class="destination" href={link.destination} target="_blank" rel="noopener noreferrer"
			><span>{link.destination}</span><Glyph name="arrowUpRight" size={16} /></a
		>
		<p class="state">
			{#if link.blocked}
				<StatusDot tone="danger">{blockLabel(link.blocked.reason)}</StatusDot>
			{:else if link.enabled}
				<StatusDot>Active</StatusDot>
			{:else}
				<StatusDot tone="neutral">Disabled</StatusDot>
			{/if}
		</p>
	</div>
	<form bind:this={toggleForm} method="post" {action} use:enhance hidden>
		<input type="hidden" name="intent" value={link.enabled ? 'disable' : 'enable'} />
		<ShownWorkspaceField />
	</form>
	<p class="status" role="status" aria-live="polite">{notice}</p>
	{#if error}
		<Callout tone="danger" role="alert"><p>{error}</p></Callout>
	{/if}
	{#if link.blocked}
		<Callout tone="danger" title={blockLabel(link.blocked.reason)}>
			<p>This link is blocked for abuse. It does not open, and you cannot change it.</p>
		</Callout>
	{:else if !link.enabled}
		<Callout>
			<p>This link is disabled. The short link does not open until you enable it.</p>
		</Callout>
	{/if}
</PageHeader>
{#if views.length > 0}{@render viewLinks('under')}{/if}

<style>
	/* Phone: the views are a two-part switch under the summary; from 48rem, pills in the bar. */
	.views {
		display: grid;
		grid-auto-columns: minmax(0, 1fr);
		grid-auto-flow: column;
		gap: 0.125rem;
		margin-bottom: 1.25rem;
		padding: 0.125rem;
		border-radius: 0.8125rem;
		background: var(--color-surface-2);
		box-shadow: var(--shadow-ring);
	}
	.views a {
		display: grid;
		place-items: center;
		min-height: 2.75rem;
		padding: 0 0.75rem;
		border-radius: 0.6875rem;
		color: var(--color-muted);
		font-size: 0.9375rem;
		font-weight: 500;
		white-space: nowrap;
		transition: color var(--dur-fast) var(--ease-out);
	}
	.views a:hover {
		color: var(--color-strong);
	}
	.views a[aria-current='page'] {
		background: var(--color-surface);
		box-shadow: var(--shadow-ring);
		color: var(--color-strong);
		font-weight: 600;
	}
	.summary {
		display: grid;
		gap: 0.375rem;
		min-width: 0;
	}
	.short {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		min-width: 0;
		color: var(--color-strong);
		font-size: 1.5rem;
		font-weight: 700;
		letter-spacing: -0.02em;
		line-height: 1.2;
	}
	.short a {
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.host {
		color: var(--color-subtle);
	}
	.short a:hover,
	.destination:hover span {
		text-decoration: underline;
		text-underline-offset: 3px;
	}
	.destination {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		justify-self: start;
		max-width: 100%;
		color: var(--color-muted);
		font-family: var(--font-mono);
		font-size: 0.8125rem;
	}
	.destination span {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.state {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
		margin-top: 0.25rem;
	}
	.status {
		color: var(--color-muted);
		font-size: 0.9375rem;
	}
	.status:empty {
		display: none;
	}
	.wide-label {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
	@media (min-width: 48rem) {
		.views.under {
			display: none;
		}
		.views.bar {
			display: flex;
			margin: 0 0 0 0.5rem;
			padding: 0;
			background: none;
			box-shadow: none;
		}
		.views.bar a {
			min-height: 2.125rem;
			padding: 0 0.625rem;
			border-radius: var(--radius-control, 0.5rem);
			font-size: 0.8125rem;
		}
		.views.bar a[aria-current='page'] {
			background: var(--color-surface-2);
			font-weight: 500;
		}
		.short {
			font-size: 1.25rem;
			font-weight: 600;
		}
		.wide-label {
			position: static;
			width: auto;
			height: auto;
			overflow: visible;
			clip-path: none;
		}
	}
	@media (min-width: 48rem) and (pointer: coarse) {
		.views.bar a {
			min-height: 2.75rem;
		}
	}
</style>
