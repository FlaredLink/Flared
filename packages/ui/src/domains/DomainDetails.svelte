<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import type { Domain } from '@flared/contracts/domains';
	import Glyph from '../icons/Glyph.svelte';
	import Button from '../atoms/Button.svelte';
	import Badge from '../atoms/Badge.svelte';
	import StatusDot from '../atoms/StatusDot.svelte';
	import Menu, { type MenuItem } from '../molecules/Menu.svelte';
	import DnsRecords from './DnsRecords.svelte';

	interface Props {
		domain: Domain;
		// Where a new link starts, and the link list filtered to this domain.
		createHref?: string;
		linksHref?: string;
		confirming: boolean;
		removing: boolean;
		busy: boolean;
		// What removal stops, such as "3 active links on this domain will stop working."
		stopping: string;
		onremove: () => void;
		onconfirm: () => void;
		oncancel: () => void;
	}
	let {
		domain,
		createHref,
		linksHref,
		confirming,
		removing,
		busy,
		stopping,
		onremove,
		onconfirm,
		oncancel
	}: Props = $props();

	const numbers = new Intl.NumberFormat();
	const dates = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
	const platform = $derived(domain.kind === 'platform');
	const linkCount = $derived(domain.activeLinks);
	let keep = $state<HTMLElement>();
	$effect(() => {
		if (confirming) keep?.querySelector('button')?.focus();
	});
	const more = $derived<MenuItem[]>([
		{
			label: `Open ${domain.hostname}`,
			icon: 'arrowUpRight',
			href: `https://${domain.hostname}`,
			external: true
		},
		...(platform
			? []
			: [{ label: 'Remove domain', icon: 'trash' as const, danger: true, onselect: onremove }])
	]);
</script>

<div class="details">
	<div class="name">
		<Glyph name={platform ? 'link' : 'globe'} size={36} />
		<div>
			<h3>{domain.hostname}</h3>
			<p class="state">
				<StatusDot>{platform ? 'Ready' : 'Active'}</StatusDot>
				{#if domain.isDefault}<Badge>Default</Badge>{/if}
				{#if platform}<Badge>Included</Badge>{/if}
			</p>
		</div>
	</div>

	<dl class="facts">
		{#if platform}
			<div>
				<dt><Glyph name="checkCircle" size={20} />Setup</dt>
				<dd><Glyph name="check" size={16} />None needed</dd>
			</div>
		{:else}
			<div>
				<dt>
					<Glyph name="database" size={20} />{domain.setup === 'worker_custom_domain'
						? 'Custom Domain'
						: 'DNS'}
				</dt>
				<dd><Glyph name="check" size={16} />Verified</dd>
			</div>
			<div>
				<dt><Glyph name="lock" size={20} />HTTPS</dt>
				<dd><Glyph name="check" size={16} />Active</dd>
			</div>
			<div>
				<dt><Glyph name="link" size={20} />Links</dt>
				<dd class="plain">{numbers.format(linkCount ?? 0)}</dd>
			</div>
			{#if domain.activatedAt}
				<div>
					<dt><Glyph name="calendar" size={20} />Active since</dt>
					<dd class="plain">{dates.format(new Date(domain.activatedAt))}</dd>
				</div>
			{/if}
		{/if}
	</dl>

	{#if createHref}<Button variant="primary" size="lg" wide href={createHref}>Create a link</Button
		>{/if}
	{#if linksHref}
		<a class="view" href={linksHref}
			>{linkCount
				? `View ${numbers.format(linkCount)} ${linkCount === 1 ? 'link' : 'links'}`
				: 'View links'}<Glyph name="arrow" size={16} /></a
		>
	{/if}

	{#if domain.isDefault}
		<div class="row">
			<Glyph name="checkCircle" size={22} />
			<div>
				<p class="row-title">Default for new links</p>
				<p class="row-text">Used as the starting domain in the link composer.</p>
			</div>
		</div>
	{/if}

	{#if !platform && domain.records.length > 0}
		<details class="row records">
			<summary
				><Glyph name="file" size={22} /><span class="row-title">DNS record</span><Glyph
					name="caret"
					size={18}
				/></summary
			>
			<p class="row-text">Keep this record in place so your links keep working.</p>
			<DnsRecords {domain} />
		</details>
	{/if}

	{#if confirming}
		<div class="confirm" role="alertdialog" aria-labelledby="remove-{domain.id}" bind:this={keep}>
			<p id="remove-{domain.id}"><strong>Remove {domain.hostname}?</strong> {stopping}</p>
			<div class="confirm-actions">
				<Button size="sm" disabled={busy} onclick={oncancel}>Keep</Button>
				<Button size="sm" variant="danger" disabled={busy} onclick={onconfirm}
					>{removing ? 'Removing…' : 'Remove'}</Button
				>
			</div>
		</div>
	{/if}

	<div class="more">
		<Menu
			id="domain-more-{domain.id}"
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
		grid-template-columns: minmax(0, 1fr);
		gap: 1.1rem;
		min-width: 0;
	}
	.name {
		display: flex;
		align-items: flex-start;
		gap: 0.85rem;
		color: var(--color-strong);
	}
	h3 {
		overflow-wrap: anywhere;
		color: var(--color-strong);
		font-size: 1.375rem;
		font-weight: 700;
		letter-spacing: -0.025em;
	}
	.state {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem 0.75rem;
		margin-top: 0.25rem;
	}
	.facts {
		display: grid;
		margin: 0;
		border-top: 1px solid var(--color-rule);
	}
	.facts div {
		display: grid;
		grid-template-columns: 9rem minmax(0, 1fr);
		align-items: center;
		min-height: 2.9rem;
		border-bottom: 1px solid var(--color-rule);
	}
	dt {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		color: var(--color-strong);
		font-size: 0.9375rem;
	}
	dd {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		margin: 0;
		color: var(--color-strong);
		font-size: 0.9375rem;
	}
	dd :global(svg) {
		color: var(--color-live);
	}
	.view {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.4rem;
		margin-top: -0.35rem;
		color: var(--color-link);
	}
	.view:hover {
		text-decoration: underline;
		text-underline-offset: 3px;
	}
	.row {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		gap: 0.85rem;
		align-items: start;
		padding-top: 1rem;
		border-top: 1px solid var(--color-rule);
		color: var(--color-strong);
	}
	.row-title {
		color: var(--color-strong);
		font-size: 0.9375rem;
	}
	.row-text {
		color: var(--color-lead);
		font-size: 0.8125rem;
	}
	.records {
		grid-template-columns: minmax(0, 1fr);
	}
	.records summary {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		gap: 0.85rem;
		align-items: center;
		list-style: none;
		cursor: pointer;
	}
	.records summary::-webkit-details-marker {
		display: none;
	}
	.records[open] summary :global(svg:last-child) {
		transform: rotate(90deg);
	}
	.confirm {
		display: grid;
		gap: 0.75rem;
		padding: 0.9rem 1rem;
		border: 1px solid color-mix(in oklch, var(--color-danger) 30%, transparent);
		border-radius: var(--radius-md, 0.625rem);
		background: var(--color-danger-soft);
		color: var(--color-ink);
		font-size: 0.9375rem;
	}
	.confirm p {
		color: inherit;
	}
	.confirm-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
	}
	.more {
		position: relative;
		margin-inline: -0.75rem;
		padding-top: 0.5rem;
	}
	.more::before {
		content: '';
		position: absolute;
		top: 0;
		right: 0.75rem;
		left: 0.75rem;
		border-top: 1px solid var(--color-rule);
	}
</style>
