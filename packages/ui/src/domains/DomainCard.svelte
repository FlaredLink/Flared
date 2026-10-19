<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import type { Domain } from '@flared/contracts/domains';
	import Glyph from '../icons/Glyph.svelte';
	import Button from '../atoms/Button.svelte';
	import Badge from '../atoms/Badge.svelte';
	import StatusDot, { type StatusTone } from '../atoms/StatusDot.svelte';
	import Stepper from '../molecules/Stepper.svelte';
	import Callout from '../molecules/Callout.svelte';
	import CopyButton from '../molecules/CopyButton.svelte';
	import Menu, { type MenuItem } from '../molecules/Menu.svelte';
	import DnsRecords from './DnsRecords.svelte';

	interface Props {
		domain: Domain;
		// No workspace domain is active yet: setup shows its steps, and an included domain offers
		// to create a link in the meantime.
		firstSetup: boolean;
		// Set after a check in this page: when it ran and what it found.
		lastCheck: { at: number; state: Domain['state'] } | null;
		checking: boolean;
		// Seconds until the API allows another check.
		wait: number;
		busy: boolean;
		guideHref?: string;
		createHref?: string;
		linksHref?: string;
		// Without these, the person may not change domains.
		oncheck?: () => void;
		onremove?: () => void;
	}
	let {
		domain,
		firstSetup,
		lastCheck,
		checking,
		wait,
		busy,
		guideHref,
		createHref,
		linksHref,
		oncheck,
		onremove
	}: Props = $props();

	const numbers = new Intl.NumberFormat();
	const dates = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
	const platform = $derived(domain.kind === 'platform');
	const worker = $derived(domain.setup === 'worker_custom_domain');
	const unfinished = $derived(
		!platform && domain.state !== 'active' && domain.state !== 'disabled'
	);
	const ready = $derived(platform || domain.state === 'active');
	let showRecords = $state(false);

	const stateLabels: Record<Domain['state'], string> = {
		pending: 'Waiting for DNS',
		verifying: 'Verifying',
		active: 'Active',
		failed: 'Setup failed',
		disabled: 'Removed'
	};
	const stateTones: Record<Domain['state'], StatusTone> = {
		pending: 'warning',
		verifying: 'warning',
		active: 'live',
		failed: 'danger',
		disabled: 'neutral'
	};
	const label = $derived(
		platform
			? 'Ready'
			: domain.state === 'pending' && worker
				? 'Waiting for setup'
				: stateLabels[domain.state]
	);
	const tone = $derived<StatusTone>(platform ? 'neutral' : stateTones[domain.state]);

	const lead = $derived.by(() => {
		if (platform)
			return firstSetup
				? 'Use it until your own domain is ready.'
				: 'Included with every workspace. No setup needed.';
		if (domain.state === 'verifying')
			return 'The record is in place. The HTTPS certificate is usually ready within an hour.';
		if (worker) return 'Add it as a Custom Domain of this Worker in Cloudflare.';
		return 'Add this record at your DNS provider. Flared issues the HTTPS certificate after it finds the record.';
	});
	const linkCount = $derived(
		domain.activeLinks === 1 ? '1 link' : `${numbers.format(domain.activeLinks ?? 0)} links`
	);

	const items = $derived.by<MenuItem[]>(() => {
		const list: MenuItem[] = [];
		if (linksHref && ready) list.push({ label: 'View links', icon: 'link', href: linksHref });
		if (ready)
			list.push({
				label: `Open ${domain.hostname}`,
				icon: 'arrowUpRight',
				href: `https://${domain.hostname}`,
				external: true
			});
		if (!platform && domain.state === 'active' && domain.records.length > 0)
			list.push({
				label: showRecords ? 'Hide DNS record' : 'Show DNS record',
				icon: 'file',
				onselect: () => (showRecords = !showRecords)
			});
		if (onremove && !platform && domain.state !== 'disabled')
			list.push({ label: 'Remove domain', icon: 'trash', danger: true, onselect: onremove });
		return list;
	});

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

<article class="card" aria-labelledby="domain-{domain.id}">
	<div class="head">
		<h2 id="domain-{domain.id}" class="host" tabindex="-1">{domain.hostname}</h2>
		{#if domain.isDefault}<Badge>Default</Badge>{/if}
		{#if platform}<Badge>Included</Badge>{/if}
		<span class="state"><StatusDot {tone} size="sm">{label}</StatusDot></span>
		{#if items.length > 0}
			<span class="menu">
				<Menu id="domain-menu-{domain.id}" label="More actions for {domain.hostname}" {items} />
			</span>
		{/if}
	</div>

	{#if domain.state === 'active' && !platform}
		<p class="lead">
			HTTPS certificate active ·
			{#if linksHref}<a href={linksHref}>{linkCount}</a>{:else}{linkCount}{/if}
			{#if domain.activatedAt}· Since {dates.format(new Date(domain.activatedAt))}{/if}
		</p>
		{#if showRecords}
			<div class="records">
				<p class="note">Keep this record in place so your links keep working.</p>
				<DnsRecords {domain} />
			</div>
		{/if}
	{:else if domain.state !== 'disabled'}
		<p class="lead">{lead}</p>
	{/if}

	{#if platform && firstSetup && createHref}
		<a class="text-action" href={createHref}>Create a link<Glyph name="arrow" size={16} /></a>
	{/if}

	{#if unfinished}
		<div class="setup">
			{#if firstSetup}
				<Stepper
					label="Setup steps"
					steps={['Add domain', worker ? 'Add Custom Domain' : 'Update DNS', 'Verify']}
					current={domain.state === 'verifying' ? 2 : 1}
				/>
			{/if}

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
				<DnsRecords {domain} />
				<p class="note">If your DNS is on Cloudflare, set the proxy status to DNS only.</p>
			{/if}

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

			<div class="actions">
				{#if oncheck}
					<Button
						icon="refresh"
						disabled={busy || wait > 0}
						aria-label={wait > 0
							? `Check ${domain.hostname} again in ${wait} seconds`
							: `Check ${domain.hostname} now`}
						onclick={oncheck}
						>{checking
							? 'Checking…'
							: wait > 0
								? `Check again in ${wait}s`
								: 'Check status'}</Button
					>
				{/if}
				<p class="note">
					{worker
						? 'Checks run automatically every 10 minutes.'
						: 'DNS changes can take time to appear. Checks also run automatically.'}
					{#if !oncheck}Only the workspace owner can check or remove this domain.{/if}
				</p>
				{#if guideHref}<a class="guide" href={guideHref}
						>{worker ? 'Setup guide' : 'DNS setup guide'}<Glyph name="arrowUpRight" size={16} /></a
					>{/if}
			</div>
		</div>
	{/if}
</article>

<style>
	.card {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 0.375rem;
		padding: 0.875rem;
		border-radius: 0.875rem;
		background: var(--color-surface);
		box-shadow: var(--shadow-ring);
		container-type: inline-size;
	}
	/* Base: the host name, its badges, and the menu share a line; the status goes under them. */
	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem 0.5rem;
		min-height: 2.25rem;
	}
	.host {
		flex: 1 1 0;
		min-width: 0;
		overflow-wrap: anywhere;
		color: var(--color-strong);
		font-family: var(--font-mono);
		font-size: 0.9375rem;
		font-weight: 500;
		letter-spacing: 0;
		line-height: 1.35;
	}
	.host:focus {
		outline: none;
	}
	.host:focus-visible {
		outline: 2px solid var(--color-focus);
		outline-offset: 2px;
	}
	.state {
		display: flex;
		flex-basis: 100%;
		order: 1;
	}
	.menu {
		display: flex;
		margin: -0.25rem -0.375rem -0.25rem 0;
	}
	.lead,
	.note,
	.checked {
		color: var(--color-subtle);
		font-size: 0.8125rem;
		line-height: 1.5;
	}
	.lead a,
	.text-action,
	.guide {
		color: var(--color-link);
		text-decoration: underline;
		text-underline-offset: 3px;
	}
	.text-action,
	.guide {
		display: inline-flex;
		align-items: center;
		justify-self: start;
		gap: 0.35rem;
		min-height: 2.75rem;
		font-size: 0.875rem;
	}
	.records,
	.setup {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 0.75rem;
		margin-top: 0.5rem;
	}
	.worker-steps {
		display: grid;
		gap: 0.5rem;
		margin: 0;
		padding-left: 1.25rem;
		color: var(--color-ink);
		font-size: 0.875rem;
	}
	.inline-copy {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
	}
	code {
		font-family: var(--font-mono);
		font-size: 0.8125rem;
	}
	/* Base: the check button runs the full width, as on a phone. */
	.actions {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 0.5rem;
	}
	@media (min-width: 48rem) {
		.card {
			padding: 0.875rem 1rem;
		}
		.host {
			font-size: 0.875rem;
		}
	}
	@container (min-width: 36rem) {
		.state {
			flex-basis: auto;
			order: 0;
		}
		.actions {
			display: flex;
			flex-wrap: wrap;
			align-items: center;
			gap: 0.5rem 1rem;
		}
		.actions .note {
			flex: 1 1 14rem;
		}
	}
</style>
