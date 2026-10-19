<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { ListedLink } from '@flared/contracts/links';
	import Glyph from '../icons/Glyph.svelte';
	import StatusDot from '../atoms/StatusDot.svelte';
	import CopyButton from '../molecules/CopyButton.svelte';
	import Menu, { type MenuItem } from '../molecules/Menu.svelte';
	import Sparkline from '../molecules/Sparkline.svelte';
	import { blockLabel } from './messages';

	interface Props {
		link: ListedLink;
		// The path of the /v1 API for this browser, such as "/api/v1", for the QR code.
		apiBase: string;
		analyticsHref?: string;
		// Where the destination and title are edited.
		editHref?: string;
		// The link's automations, shown after the clicks.
		automations?: Snippet;
	}
	let { link, apiBase, analyticsHref, editHref, automations }: Props = $props();

	const numbers = new Intl.NumberFormat();
	const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'short', timeZone: 'UTC' });
	const longDay = new Intl.DateTimeFormat(undefined, {
		weekday: 'long',
		month: 'short',
		day: 'numeric',
		timeZone: 'UTC'
	});
	const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

	// The list carries one count per UTC day for the last 30 days, ending today.
	const week = $derived(link.dailyClicksLast30Days?.slice(-7) ?? null);
	const total = $derived(week ? week.reduce((sum, value) => sum + value, 0) : null);
	const days = $derived.by(() => {
		if (!week) return [];
		const now = new Date();
		const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
		return week.map((clicks, index) => {
			const day = today - (week.length - 1 - index) * 86_400_000;
			const last = index === week.length - 1;
			return {
				short: last ? 'Today' : weekday.format(day),
				long: last ? 'Today' : longDay.format(day),
				clicks
			};
		});
	});

	const qr = $derived(`${apiBase}/links/${encodeURIComponent(link.id)}/qr`);
	let qrStatus = $state('');
	const qrItems = $derived<MenuItem[]>([
		{ label: 'PNG image', icon: 'image', href: `${qr}?format=png&size=1024&download=1` },
		{ label: 'SVG image', icon: 'image', href: `${qr}?format=svg&download=1` },
		{ label: 'Copy image', icon: 'copy', onselect: () => void copyQr() }
	]);

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
</script>

<div class="details">
	<div class="head">
		<!-- Opens the short link, so the owner can try the redirect. -->
		<h3 class="short">
			<a href={link.shortUrl} target="_blank" rel="noopener noreferrer"
				><span class="host">{link.hostname}/</span>{link.slug}</a
			>
		</h3>
		<CopyButton text={link.shortUrl} label="Copy short link" size="sm" />
	</div>
	<div class="state">
		{#if link.title}<p class="title">{link.title}</p>{/if}
		{#if link.blocked}
			<StatusDot tone="danger">{blockLabel(link.blocked.reason)}</StatusDot>
		{:else if link.enabled}
			<StatusDot>Active</StatusDot>
		{:else}
			<StatusDot tone="neutral">Disabled</StatusDot>
		{/if}
	</div>

	<div class="block">
		<p class="label" id="link-destination-label">Destination</p>
		<div class="field">
			<a
				href={link.destination}
				target="_blank"
				rel="noopener noreferrer"
				aria-describedby="link-destination-label"
				title={link.destination}>{link.destination}</a
			>
			{#if editHref && !link.blocked}
				<a class="edit" href={editHref} aria-label="Edit link" title="Edit link"
					><Glyph name="pencil" size={16} /></a
				>
			{/if}
		</div>
		{#if link.iosDestination || link.androidDestination}
			<dl class="devices">
				{#if link.iosDestination}<dt>iPhone</dt>
					<dd>{link.iosDestination}</dd>{/if}
				{#if link.androidDestination}<dt>Android</dt>
					<dd>{link.androidDestination}</dd>{/if}
			</dl>
		{/if}
	</div>

	<div class="block">
		<div class="row">
			<p class="label" id="link-week-label">Clicks, last 7 days</p>
			{#if total !== null}<strong class="total">{numbers.format(total)}</strong>{/if}
		</div>
		{#if week}
			<div class="week"><Sparkline values={week} today /></div>
			<div class="days" aria-hidden="true">
				{#each days as day, index (index)}<span>{day.short}</span>{/each}
			</div>
			<ul class="visually-hidden" aria-labelledby="link-week-label">
				{#each days as day, index (index)}
					<li>{day.long}: {numbers.format(day.clicks)} {day.clicks === 1 ? 'click' : 'clicks'}</li>
				{/each}
			</ul>
		{:else}
			<p class="note">Clicks are not available right now.</p>
		{/if}
		{#if analyticsHref}<a class="more" href={analyticsHref}
				>View analytics<Glyph name="arrow" size={16} /></a
			>{/if}
	</div>

	{#if automations}
		<div class="block">{@render automations()}</div>
	{/if}

	<div class="qr">
		<img
			src="{qr}?format=svg"
			alt="QR code for {link.hostname}/{link.slug}"
			width="56"
			height="56"
		/>
		<p class="qr-text">QR code<span>PNG or SVG</span></p>
		<Menu id="link-qr-menu-{link.id}" label="Download QR code" icon="download" items={qrItems} />
		<p class="qr-status" role="status">{qrStatus}</p>
	</div>

	<dl class="facts">
		<dt>Created</dt>
		<dd>{dateFormat.format(new Date(link.createdAt))}</dd>
		<dt>Updated</dt>
		<dd>{dateFormat.format(new Date(link.updatedAt))}</dd>
	</dl>
</div>

<style>
	.details {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 1rem;
		min-width: 0;
	}
	.head {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
	}
	.short {
		flex: 1;
		min-width: 0;
		margin: 0;
		padding-top: 0.25rem;
		color: var(--color-strong);
		font-size: 1.125rem;
		font-weight: 600;
		letter-spacing: -0.01em;
		line-height: 1.3;
		overflow-wrap: anywhere;
	}
	.short a {
		color: inherit;
	}
	.short a:hover {
		text-decoration: underline;
		text-underline-offset: 3px;
	}
	.host {
		color: var(--color-subtle);
		font-weight: 500;
	}
	.state {
		display: grid;
		gap: 0.25rem;
		margin-top: -0.5rem;
	}
	.title {
		color: var(--color-muted);
		font-size: 0.875rem;
		overflow-wrap: anywhere;
	}
	.block {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 0.375rem;
	}
	.row {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 1rem;
	}
	.label {
		color: var(--color-subtle);
		font-size: 0.75rem;
	}
	.field {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-height: 2.25rem;
		padding: 0 0.25rem 0 0.625rem;
		border-radius: 0.5625rem;
		background: var(--color-surface-2);
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 0.75rem;
	}
	.field > a:first-child {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		color: var(--color-strong);
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.field > a:first-child:hover {
		text-decoration: underline;
		text-underline-offset: 3px;
	}
	.edit {
		display: inline-grid;
		flex: none;
		place-items: center;
		width: 2rem;
		height: 2rem;
		border-radius: 0.5rem;
		color: var(--color-subtle);
	}
	.edit:hover {
		background: var(--color-surface-3);
		color: var(--color-strong);
	}
	@media (pointer: coarse) {
		.edit {
			width: 2.75rem;
			height: 2.75rem;
		}
	}
	.total {
		color: var(--color-strong);
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}
	.week {
		--sparkline-gap: 0.375rem;
		--sparkline-radius: 5px 5px 2px 2px;
		height: 5.25rem;
	}
	.days {
		display: grid;
		grid-template-columns: repeat(7, minmax(0, 1fr));
		gap: 0.375rem;
		color: var(--color-subtle);
		font-size: 0.6875rem;
		text-align: center;
	}
	.note {
		color: var(--color-subtle);
		font-size: 0.875rem;
	}
	.more {
		display: inline-flex;
		align-items: center;
		justify-self: start;
		gap: 0.35rem;
		min-height: 2.25rem;
		color: var(--color-link);
		font-size: 0.875rem;
		text-decoration: underline;
		text-underline-offset: 3px;
	}
	.qr {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.75rem;
		padding-top: 0.875rem;
		border-top: 1px solid var(--color-rule-soft);
	}
	/* The code stays dark on white in both themes, so every scanner reads it. */
	.qr img {
		width: 68px;
		height: 68px;
		padding: 6px;
		border-radius: 0.5rem;
		background: #fff;
		box-shadow: 0 0 0 1px rgb(10 10 10 / 0.08);
	}
	.qr-text {
		display: grid;
		flex: 1;
		color: var(--color-muted);
		font-size: 0.8125rem;
	}
	.qr-text span {
		color: var(--color-subtle);
		font-size: 0.75rem;
	}
	.qr-status {
		flex-basis: 100%;
		color: var(--color-subtle);
		font-size: 0.8125rem;
	}
	.qr-status:empty {
		display: none;
	}
	.facts {
		display: grid;
		grid-template-columns: 5rem minmax(0, 1fr);
		gap: 0.25rem 0.75rem;
		margin: 0;
		padding-top: 0.875rem;
		border-top: 1px solid var(--color-rule-soft);
		font-size: 0.8125rem;
	}
	dt {
		color: var(--color-subtle);
	}
	dd {
		margin: 0;
		color: var(--color-strong);
	}
	.devices {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		gap: 0.25rem 0.75rem;
		margin: 0.375rem 0 0;
		font-size: 0.8125rem;
	}
	.devices dd {
		overflow-wrap: anywhere;
	}
	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
</style>
