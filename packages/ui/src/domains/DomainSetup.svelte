<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import type { Domain } from '@flared/contracts/domains';
	import Glyph from '../icons/Glyph.svelte';
	import Button from '../atoms/Button.svelte';
	import Badge from '../atoms/Badge.svelte';
	import Stepper from '../molecules/Stepper.svelte';
	import Callout from '../molecules/Callout.svelte';
	import CopyButton from '../molecules/CopyButton.svelte';
	import DnsRecords from './DnsRecords.svelte';

	interface Props {
		domain: Domain;
		// Set after a check in this page: when it ran and what it found.
		lastCheck: { at: number; state: Domain['state'] } | null;
		checking: boolean;
		// Seconds until the API allows another check.
		wait: number;
		busy: boolean;
		guideHref?: string;
		oncheck: () => void;
		onremove: () => void;
	}
	let { domain, lastCheck, checking, wait, busy, guideHref, oncheck, onremove }: Props = $props();

	const worker = $derived(domain.setup === 'worker_custom_domain');
	const step = $derived(domain.state === 'verifying' ? 2 : 1);
	const pill = $derived(
		domain.state === 'failed'
			? { tone: 'danger' as const, icon: 'warningCircle' as const, label: 'Setup failed' }
			: domain.state === 'verifying'
				? { tone: 'warning' as const, icon: 'clock' as const, label: 'Verifying' }
				: {
						tone: 'warning' as const,
						icon: 'clock' as const,
						label: worker ? 'Waiting for setup' : 'Waiting for DNS'
					}
	);
	const times = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
	let now = $state(Date.now());
	$effect(() => {
		if (!lastCheck) return;
		const timer = setInterval(() => (now = Date.now()), 15_000);
		return () => clearInterval(timer);
	});
	const checkedText = $derived.by(() => {
		if (!lastCheck) return '';
		const minutes = Math.round((now - lastCheck.at) / 60_000);
		return minutes < 1
			? 'Last checked just now.'
			: `Last checked ${times.format(-minutes, 'minute')}.`;
	});
</script>

<section class="setup" aria-labelledby="domain-setup-{domain.id}">
	<div class="title">
		<Glyph name="globe" size={40} />
		<div class="name">
			<div class="name-row">
				<h2 id="domain-setup-{domain.id}">{domain.hostname}</h2>
				<Badge tone={pill.tone} icon={pill.icon} outlined>{pill.label}</Badge>
			</div>
			<p>
				{worker
					? 'Add it as a Custom Domain of this Worker in Cloudflare.'
					: 'Add the record below at your DNS provider.'}
			</p>
		</div>
	</div>

	<Stepper
		label="Setup steps"
		steps={['Add domain', worker ? 'Add Custom Domain' : 'Update DNS', 'Verify']}
		current={step}
	/>

	{#if worker}
		<ol class="worker-steps">
			<li>
				In the Cloudflare dashboard, open <strong>Workers &amp; Pages</strong> and select this Flared
				Worker.
			</li>
			<li>
				Open <strong>Settings → Domains &amp; Routes</strong>, choose <strong>Add</strong>, then
				<strong>Custom domain</strong>.
			</li>
			<li>
				<span class="inline-copy"
					>Enter <code>{domain.hostname}</code><CopyButton
						text={domain.hostname}
						label="Copy {domain.hostname}"
						size="sm"
					/></span
				>
			</li>
		</ol>
		<p class="note">The domain must be on Cloudflare in the same account as this Worker.</p>
	{/if}

	{#if domain.records.length > 0}
		<div class="records">
			<p class="lead">Add this record with your DNS provider.</p>
			<DnsRecords {domain} />
			<p class="note">If your DNS is on Cloudflare, set the proxy status to DNS only.</p>
		</div>
	{/if}

	<p class="lead">
		{domain.state === 'verifying'
			? 'The record is in place. The HTTPS certificate is usually ready within an hour.'
			: worker
				? 'Checks run automatically every 10 minutes.'
				: 'DNS changes can take time to appear. Checks also run automatically.'}
	</p>
	<div class="actions">
		<Button
			variant="primary"
			icon="refresh"
			disabled={busy || wait > 0}
			aria-label={wait > 0
				? `Check ${domain.hostname} again in ${wait} seconds`
				: `Check ${domain.hostname} now`}
			onclick={oncheck}
			>{checking ? 'Checking…' : wait > 0 ? `Check again in ${wait}s` : 'Check status'}</Button
		>
		{#if guideHref}<a class="guide" href={guideHref}
				>{worker ? 'Setup guide' : 'DNS setup guide'}<Glyph name="arrowUpRight" size={16} /></a
			>{/if}
	</div>

	{#if domain.state === 'failed'}
		<Callout tone="danger" title="The last check failed" role="alert">
			<p>{domain.error?.message ?? 'Check the setup above, then check again.'}</p>
		</Callout>
	{:else if lastCheck && lastCheck.state === 'pending'}
		<Callout tone="warning" role="status">
			<p>
				{worker
					? 'The Custom Domain is not set up yet. Check the steps above, then try again.'
					: 'Record not detected yet. Check the name and target, then try again.'}
			</p>
			<p class="checked">{checkedText}</p>
		</Callout>
	{:else if lastCheck}
		<Callout tone="info" role="status">
			<p>The record is in place. Flared is issuing the HTTPS certificate.</p>
			<p class="checked">{checkedText}</p>
		</Callout>
	{/if}

	<p class="remove">
		<Button variant="link" disabled={busy} onclick={onremove}>Remove this domain</Button>
	</p>
</section>

<style>
	.setup {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 1.5rem;
		width: min(100%, 40rem);
		margin-inline: auto;
	}
	.title {
		display: flex;
		align-items: flex-start;
		gap: 1rem;
		color: var(--color-strong);
	}
	.name {
		flex: 1;
		display: grid;
		gap: 0.3rem;
		min-width: 0;
	}
	.name-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem 1rem;
	}
	h2 {
		overflow-wrap: anywhere;
		color: var(--color-strong);
		font-size: 1.75rem;
		font-weight: 750;
		letter-spacing: -0.03em;
		line-height: 1.15;
	}
	.name p,
	.lead {
		color: var(--color-lead);
		font-size: 0.9375rem;
	}
	.lead {
		color: var(--color-ink);
	}
	.records {
		display: grid;
		gap: 0.6rem;
	}
	.note {
		color: var(--color-lead);
		font-size: 0.8125rem;
	}
	.worker-steps {
		display: grid;
		gap: 0.5rem;
		margin: 0;
		padding-left: 1.25rem;
		color: var(--color-ink);
		font-size: 0.9375rem;
	}
	.inline-copy {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
	}
	code {
		font-family: var(--font-mono);
		font-size: 0.875rem;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.75rem 1.5rem;
		margin-top: -0.75rem;
	}
	.guide {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		color: var(--color-link);
		text-decoration: underline;
		text-underline-offset: 3px;
	}
	.checked {
		color: var(--color-lead);
		font-size: 0.8125rem;
	}
	.remove :global(.button) {
		min-height: 2.25rem;
		color: var(--color-danger);
		font-size: 0.875rem;
	}
</style>
