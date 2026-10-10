<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import type { ListedLink } from '@flared/contracts/links';
	import Glyph from '../icons/Glyph.svelte';
	import Button from '../atoms/Button.svelte';
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
	}
	let { link, apiBase, analyticsHref, editHref }: Props = $props();

	const numbers = new Intl.NumberFormat();
	const dayFormat = new Intl.DateTimeFormat(undefined, {
		month: 'short',
		day: 'numeric',
		timeZone: 'UTC'
	});
	const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
	let days = $state('30');

	// The list carries one count per UTC day for the last 30 days, ending today.
	const daily = $derived(link.dailyClicksLast30Days ?? null);
	const shown = $derived(daily ? daily.slice(-Number(days)) : null);
	const total = $derived(shown ? shown.reduce((sum, value) => sum + value, 0) : null);
	const range = $derived.by(() => {
		if (!shown) return null;
		const today = new Date();
		const end = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
		const start = end - (shown.length - 1) * 86_400_000;
		return { start: dayFormat.format(start), end: dayFormat.format(end) };
	});
	const qr = $derived(`${apiBase}/links/${encodeURIComponent(link.id)}/qr`);
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

	const more = $derived<MenuItem[]>([
		...(analyticsHref
			? [{ label: 'View analytics', icon: 'chart' as const, href: analyticsHref }]
			: []),
		...(editHref && !link.blocked
			? [{ label: 'Edit link', icon: 'pencil' as const, href: editHref }]
			: []),
		{ label: 'Open short link', icon: 'arrowUpRight', href: link.shortUrl, external: true },
		{ label: 'Open destination', icon: 'external', href: link.destination, external: true }
	]);
</script>

<div class="details">
	<div class="name">
		<h3>{link.title ?? `${link.hostname}/${link.slug}`}</h3>
		{#if link.blocked}
			<StatusDot tone="danger">{blockLabel(link.blocked.reason)}</StatusDot>
		{:else if link.enabled}
			<StatusDot>Active</StatusDot>
		{:else}
			<StatusDot tone="neutral">Disabled</StatusDot>
		{/if}
	</div>
	<p class="short"><span>{link.hostname}/</span><strong>{link.slug}</strong></p>
	<CopyButton
		text={link.shortUrl}
		label="Copy link"
		kind="button"
		variant="primary"
		size="lg"
		wide
	/>

	<div class="block">
		<div class="row">
			<h4>Destination</h4>
			{#if editHref && !link.blocked}<a class="edit" href={editHref}>Edit</a>{/if}
		</div>
		<a class="destination" href={link.destination} target="_blank" rel="noopener noreferrer"
			><span>{link.destination}</span><Glyph name="external" size={20} /></a
		>
	</div>

	<div class="block">
		<div class="row">
			<h4 id="link-performance-heading">Performance</h4>
			<label class="range">
				<span class="visually-hidden">Period</span>
				<select bind:value={days} aria-describedby="link-performance-heading">
					<option value="7">7 days</option>
					<option value="30">30 days</option>
				</select>
				<Glyph name="caretDown" size={14} />
			</label>
		</div>
		{#if shown && total !== null && range}
			<p class="total">
				<strong>{numbers.format(total)}</strong> total {total === 1 ? 'click' : 'clicks'}
			</p>
			<Sparkline values={shown} height={72} />
			<p class="dates"><span>{range.start}</span><span>{range.end}</span></p>
			<div class="row">
				<p class="note">{total === 0 ? 'No clicks in this period.' : ''}</p>
				{#if analyticsHref}<a class="link" href={analyticsHref}
						>View analytics<Glyph name="arrow" size={16} /></a
					>{/if}
			</div>
		{:else}
			<p class="note">Clicks are not available right now.</p>
		{/if}
	</div>

	<div class="block qr">
		<img
			src="{qr}?format=svg"
			alt="QR code for {link.hostname}/{link.slug}"
			width="88"
			height="88"
		/>
		<div class="qr-body">
			<h4>QR code</h4>
			<p class="formats">
				<a href="{qr}?format=png&size=1024&download=1" download>PNG</a> ·
				<a href="{qr}?format=svg&download=1" download>SVG</a>
			</p>
			<div class="qr-actions">
				<Button size="sm" icon="copy" onclick={copyQr}>Copy QR</Button>
				<Button size="sm" icon="download" href="{qr}?format=png&size=1024&download=1" download
					>Download</Button
				>
			</div>
			<p class="qr-status" role="status">{qrStatus}</p>
		</div>
	</div>

	<dl class="block facts">
		<dt>Created</dt>
		<dd>{dateFormat.format(new Date(link.createdAt))}</dd>
		<dt>Updated</dt>
		<dd>{dateFormat.format(new Date(link.updatedAt))}</dd>
	</dl>

	<div class="block more">
		<Menu
			id="link-details-more-{link.id}"
			label="More actions"
			text="More actions"
			align="start"
			items={more}
		/>
	</div>
</div>

<style>
	.details {
		display: grid;
		gap: 1rem;
		min-width: 0;
	}
	.name {
		display: grid;
		gap: 0.2rem;
	}
	h3 {
		overflow-wrap: anywhere;
		color: var(--color-strong);
		font-size: 1.75rem;
		font-weight: 750;
		letter-spacing: -0.035em;
		line-height: 1.15;
	}
	.short {
		overflow-wrap: anywhere;
		color: var(--color-strong);
		font-size: 2.1rem;
		letter-spacing: -0.04em;
		line-height: 1.15;
	}
	.short span {
		color: var(--color-lead);
		font-weight: 400;
	}
	.short strong {
		font-weight: 750;
	}
	.block {
		display: grid;
		gap: 0.6rem;
		padding-top: 1.1rem;
		border-top: 1px solid var(--color-rule);
	}
	.row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
	}
	h4 {
		margin: 0;
		color: var(--color-strong);
		font-size: 1rem;
		font-weight: 600;
	}
	.edit,
	.link,
	.formats a {
		color: var(--color-link);
	}
	.edit:hover,
	.link:hover,
	.formats a:hover {
		text-decoration: underline;
		text-underline-offset: 3px;
	}
	.destination {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		color: var(--color-link);
		font-size: 1rem;
	}
	.destination span {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.destination :global(svg) {
		color: var(--color-ink);
	}
	.range {
		position: relative;
		display: inline-flex;
		align-items: center;
		color: var(--color-strong);
	}
	.range select {
		min-height: 2.25rem;
		padding: 0 2rem 0 0.75rem;
		border: 1px solid var(--color-rule);
		border-radius: var(--radius-control, 0.5rem);
		background: var(--color-paper);
		color: inherit;
		font: inherit;
		font-size: 0.875rem;
		appearance: none;
	}
	.range select option {
		background: var(--color-paper);
	}
	.range :global(svg) {
		position: absolute;
		right: 0.65rem;
		pointer-events: none;
	}
	.total {
		display: flex;
		align-items: baseline;
		gap: 0.6rem;
		color: var(--color-lead);
		font-size: 1.0625rem;
	}
	.total strong {
		color: var(--color-strong);
		font-size: 2.75rem;
		font-weight: 750;
		letter-spacing: -0.04em;
		line-height: 1;
		font-variant-numeric: tabular-nums;
	}
	.dates {
		display: flex;
		justify-content: space-between;
		color: var(--color-lead);
		font-size: 0.875rem;
	}
	.note {
		color: var(--color-lead);
		font-size: 0.9375rem;
		font-style: italic;
	}
	.link {
		display: inline-flex;
		flex: none;
		align-items: center;
		gap: 0.35rem;
		font-size: 0.9375rem;
	}
	.qr {
		grid-template-columns: auto minmax(0, 1fr);
		align-items: start;
		gap: 1rem;
	}
	.qr img {
		width: 88px;
		height: 88px;
		padding: 4px;
		border: 1px solid var(--color-rule);
		border-radius: var(--radius-sm, 0.375rem);
		background: #fff;
	}
	.qr-body {
		display: grid;
		gap: 0.3rem;
	}
	.formats {
		color: var(--color-lead);
		font-size: 0.875rem;
	}
	.qr-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin-top: 0.35rem;
	}
	.qr-status {
		color: var(--color-lead);
		font-size: 0.8125rem;
	}
	.qr-status:empty {
		display: none;
	}
	.facts {
		grid-template-columns: 6rem minmax(0, 1fr);
		margin: 0;
		row-gap: 0.4rem;
	}
	dt {
		color: var(--color-strong);
		font-size: 0.9375rem;
	}
	dd {
		margin: 0;
		color: var(--color-lead);
		font-size: 0.9375rem;
	}
	.more {
		margin-inline: -0.75rem;
		padding-inline: 0;
		border-top: 0;
		position: relative;
	}
	.more::before {
		content: '';
		position: absolute;
		top: 0;
		right: 0.75rem;
		left: 0.75rem;
		border-top: 1px solid var(--color-rule);
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
