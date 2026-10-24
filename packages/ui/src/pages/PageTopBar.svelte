<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts" module>
	export interface PageViewLink {
		label: string;
		href: string;
		current: boolean;
	}
</script>

<script lang="ts">
	import type { Page } from '@flared/contracts/pages';
	import Button from '../atoms/Button.svelte';
	import StatusDot from '../atoms/StatusDot.svelte';
	import type { Crumb } from '../molecules/Breadcrumbs.svelte';
	import Callout from '../molecules/Callout.svelte';
	import CopyButton from '../molecules/CopyButton.svelte';
	import Dialog from '../molecules/Dialog.svelte';
	import Menu, { type MenuItem } from '../molecules/Menu.svelte';
	import PageHeader from '../molecules/PageHeader.svelte';
	import { blockLabel } from '../links/messages';
	import { shownWorkspace } from '../workspace/shown';
	import { deletePage, pageErrorMessage, updatePage } from './client';

	interface Props {
		apiBase: string;
		page: Page;
		// The trail to this page, ending with the page.
		crumbs: Crumb[];
		// The page list, for the phone back button.
		backHref: string;
		views?: PageViewLink[];
		onchanged: (page: Page) => void | Promise<void>;
		ondeleted: () => void | Promise<void>;
	}

	let { apiBase, page, crumbs, backHref, views = [], onchanged, ondeleted }: Props = $props();
	const workspace = shownWorkspace();

	let pending = $state(false);
	let error = $state('');
	let confirmOpen = $state(false);
	const address = $derived(page.domainUrl ?? page.url);

	async function toggle() {
		pending = true;
		error = '';
		const result = await updatePage(apiBase, page.id, { enabled: !page.enabled }, workspace());
		pending = false;
		if (result.ok) await onchanged(result.value);
		else error = pageErrorMessage(result.failure);
	}

	async function remove() {
		pending = true;
		error = '';
		const result = await deletePage(apiBase, page.id, workspace());
		if (result.ok) {
			await ondeleted();
			return;
		}
		pending = false;
		confirmOpen = false;
		error = pageErrorMessage(result.failure);
	}

	const moreItems = $derived<MenuItem[]>([
		...(page.blocked
			? []
			: [
					{
						label: page.enabled ? 'Turn off page' : 'Turn on page',
						icon: page.enabled ? ('pause' as const) : ('play' as const),
						disabled: pending,
						onselect: () => void toggle()
					},
					{
						label: 'Delete page',
						icon: 'trash' as const,
						danger: true,
						disabled: pending,
						onselect: () => (confirmOpen = true)
					}
				])
	]);
</script>

<!-- The views are tabs of one screen, so a switch replaces the history entry and back still
     leads to the page list. -->
{#snippet viewLinks(placement: 'bar' | 'under')}
	<nav class="views {placement}" aria-label="Page views">
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

<PageHeader {crumbs} back={{ href: backHref, label: 'Pages' }} title={page.title}>
	{#snippet top(placement)}
		{#if placement === 'bar' && views.length > 0}{@render viewLinks('bar')}{/if}
	{/snippet}
	{#snippet aside()}
		{#if address && page.enabled && !page.blocked}
			<Button size="sm" icon="arrowUpRight" href={address} target="_blank" rel="noopener noreferrer"
				><span class="wide-label">Open page</span></Button
			>
		{/if}
		{#if moreItems.length > 0}
			<Menu id="page-more-menu" label="More actions for {page.title}" items={moreItems} />
		{/if}
	{/snippet}
	<div class="summary">
		{#if address}
			<p class="address">
				<a href={address} target="_blank" rel="noopener noreferrer"
					>{address.replace(/^https:\/\//, '')}</a
				>
				<CopyButton text={address} label="Copy page address" size="sm" />
			</p>
		{/if}
		<p class="state">
			{#if page.blocked}
				<StatusDot tone="danger">{blockLabel(page.blocked.reason)}</StatusDot>
			{:else if page.enabled}
				<StatusDot>On</StatusDot>
			{:else}
				<StatusDot tone="neutral">Off</StatusDot>
			{/if}
		</p>
	</div>
	{#if error}
		<Callout tone="danger" role="alert"><p>{error}</p></Callout>
	{/if}
	{#if !page.enabled && !page.blocked}
		<Callout>
			<p>This page is off. Visitors see “not found” until you turn it on.</p>
		</Callout>
	{/if}
</PageHeader>
{#if views.length > 0}{@render viewLinks('under')}{/if}

<Dialog bind:open={confirmOpen} id="page-delete-heading" title="Delete {page.title}?">
	<p class="confirm-text">
		The page stops showing at once. Its buttons stay as links. Its address stays with your
		workspace.
	</p>
	<div class="confirm-actions">
		<Button disabled={pending} onclick={() => (confirmOpen = false)}>Keep</Button>
		<Button variant="danger" disabled={pending} onclick={() => void remove()}
			>{pending ? 'Deleting…' : 'Delete'}</Button
		>
	</div>
</Dialog>

<style>
	/* Phone: the views are a switch under the summary; from 48rem, pills in the bar. */
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
	.address {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		min-width: 0;
		color: var(--color-strong);
		font-size: 1.25rem;
		font-weight: 700;
		letter-spacing: -0.02em;
		line-height: 1.2;
	}
	.address a {
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.address a:hover {
		text-decoration: underline;
		text-underline-offset: 3px;
	}
	.state {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
		margin-top: 0.25rem;
	}
	.wide-label {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
	.confirm-text {
		color: var(--color-muted);
		font-size: 0.9375rem;
	}
	/* Base: the confirm buttons share the width, as in a phone sheet. */
	.confirm-actions {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.5rem;
		margin-top: 1rem;
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
		.address {
			font-size: 1.125rem;
			font-weight: 600;
		}
		.wide-label {
			position: static;
			width: auto;
			height: auto;
			overflow: visible;
			clip-path: none;
		}
		.confirm-actions {
			display: flex;
			justify-content: flex-end;
		}
	}
	@media (min-width: 48rem) and (pointer: coarse) {
		.views.bar a {
			min-height: 2.75rem;
		}
	}
</style>
