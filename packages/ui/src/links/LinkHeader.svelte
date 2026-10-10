<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import ShownWorkspaceField from '../workspace/ShownWorkspaceField.svelte';
	import type { Action } from 'svelte/action';
	import type { Link } from '@flared/contracts/links';
	import Glyph from '../icons/Glyph.svelte';
	import Button from '../atoms/Button.svelte';
	import StatusDot from '../atoms/StatusDot.svelte';
	import Breadcrumbs, { type Crumb } from '../molecules/Breadcrumbs.svelte';
	import CopyButton from '../molecules/CopyButton.svelte';
	import Menu, { type MenuItem } from '../molecules/Menu.svelte';
	import Callout from '../molecules/Callout.svelte';
	import { blockLabel } from './messages';

	interface Props {
		link: Link;
		// The path of the /v1 API for this browser, such as "/api/v1", for the QR code.
		apiBase: string;
		crumbs?: Crumb[];
		// The link list, for the back link.
		backHref: string;
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
		apiBase,
		crumbs,
		backHref,
		action,
		enhance = () => {},
		pending = false,
		notice = '',
		error = null,
		onedit
	}: Props = $props();

	const shortName = $derived(`${link.hostname}/${link.slug}`);
	const qr = $derived(`${apiBase}/links/${encodeURIComponent(link.id)}/qr`);
	let toggleForm = $state<HTMLFormElement>();
	let qrStatus = $state('');

	// Copies the PNG where the browser allows images on the clipboard.
	async function copyQr() {
		try {
			const response = await fetch(`${qr}?format=png&size=1024`);
			if (!response.ok) throw new Error('qr');
			const blob = await response.blob();
			await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
			qrStatus = 'QR code copied.';
		} catch {
			qrStatus = 'This browser cannot copy images. Download the QR code instead.';
		}
	}

	const qrItems = $derived<MenuItem[]>([
		{ label: 'Download PNG', icon: 'download', href: `${qr}?format=png&size=1024&download=1` },
		{ label: 'Download SVG', icon: 'download', href: `${qr}?format=svg&download=1` },
		{ label: 'Copy QR image', icon: 'copy', onselect: () => void copyQr() }
	]);
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

<header class="link-header">
	{#if crumbs}<Breadcrumbs items={crumbs} />{/if}
	<a class="back" href={backHref}><Glyph name="arrowLeft" size={18} />All links</a>
	<div class="row">
		<div class="titles">
			<div class="name">
				<h1>{link.title ?? shortName}</h1>
				{#if link.blocked}
					<StatusDot tone="danger">{blockLabel(link.blocked.reason)}</StatusDot>
				{:else if link.enabled}
					<StatusDot>Active</StatusDot>
				{:else}
					<StatusDot tone="neutral">Disabled</StatusDot>
				{/if}
			</div>
			<div class="short">
				<a href={link.shortUrl} target="_blank" rel="noopener noreferrer">{shortName}</a>
				<CopyButton text={link.shortUrl} label="Copy {shortName}" size="sm" />
			</div>
			<a class="destination" href={link.destination} target="_blank" rel="noopener noreferrer"
				><span>{link.destination}</span><Glyph name="arrowUpRight" size={18} /></a
			>
		</div>
		<div class="actions">
			<CopyButton text={link.shortUrl} label="Copy link" kind="button" variant="primary" />
			<span class="qr-menu">
				<Menu
					id="link-qr-menu"
					label="QR code"
					text="QR code"
					icon="qr"
					caret="caretDown"
					items={qrItems}
					class="qr-trigger"
				/>
			</span>
			{#if onedit && !link.blocked}
				<Button icon="pencil" onclick={onedit}>Edit</Button>
			{/if}
			<span class="more-menu">
				<Menu
					id="link-more-menu"
					label="More actions for {shortName}"
					items={moreItems}
					class="more-trigger"
				/>
			</span>
		</div>
	</div>
	<form bind:this={toggleForm} method="post" {action} use:enhance hidden>
		<input type="hidden" name="intent" value={link.enabled ? 'disable' : 'enable'} />
		<ShownWorkspaceField />
	</form>
	<p class="status" role="status" aria-live="polite">{qrStatus || notice}</p>
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
</header>

<style>
	.link-header {
		display: grid;
		gap: 0.85rem;
		margin-bottom: 1.75rem;
	}
	.back {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		justify-self: start;
		color: var(--color-lead);
		font-size: 0.9375rem;
	}
	.back:hover {
		color: var(--color-strong);
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem 1.5rem;
	}
	.titles {
		display: grid;
		gap: 0.4rem;
		min-width: 0;
		flex: 1 1 22rem;
	}
	.name {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.4rem 1rem;
	}
	h1 {
		color: var(--color-strong);
		font-size: clamp(2rem, 3.2vw, 2.75rem);
		font-weight: 800;
		letter-spacing: -0.045em;
		line-height: 1.05;
	}
	.short {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		color: var(--color-strong);
		font-size: 1.375rem;
		letter-spacing: -0.02em;
	}
	.short a {
		overflow-wrap: anywhere;
	}
	.short a:hover,
	.destination:hover span {
		text-decoration: underline;
		text-underline-offset: 3px;
	}
	.destination {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		justify-self: start;
		max-width: 100%;
		color: var(--color-lead);
		font-size: 1rem;
	}
	.destination span {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.6rem;
	}
	/* The menus here look like secondary buttons. Each override names its wrapper twice over the
	   menu's own two classes, so it wins whatever order the styles load in. */
	.actions .qr-menu :global(.qr-trigger) {
		width: auto;
		min-height: 2.75rem;
		padding: 0 1rem;
		border-color: var(--color-rule);
		background: var(--color-paper);
		font-weight: 600;
	}
	.actions .qr-menu :global(.qr-trigger:hover),
	.actions .more-menu :global(.more-trigger:hover) {
		background: var(--color-selected);
	}
	.actions .more-menu :global(.more-trigger) {
		width: 2.75rem;
		height: 2.75rem;
		border-color: var(--color-rule);
		background: var(--color-paper);
	}
	.status {
		color: var(--color-lead);
		font-size: 0.9375rem;
	}
	.status:empty {
		display: none;
	}
	@media (max-width: 40rem) {
		.actions {
			width: 100%;
		}
	}
</style>
