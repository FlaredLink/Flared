<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import EmptyState from '../empty/EmptyState.svelte';
	import type { Action } from 'svelte/action';
	import {
		domainCheckIntervalMs,
		normalizeHostname,
		type Domain,
		type DomainPage
	} from '@flared/contracts/domains';
	import { LinkInputError } from '@flared/contracts/links';
	import { addDomain, checkDomain, domainErrorMessage, removeDomain } from './client';

	interface Props {
		page: DomainPage;
		// The path of the /v1 API for this browser, such as "/api/v1".
		apiBase: string;
		// Called after a change succeeds, so the app reloads the list.
		onChanged: () => void | Promise<void>;
	}

	let { page, apiBase, onChanged }: Props = $props();

	let hostname = $state('');
	let fieldError = $state('');
	// "add", "check:<id>", or "remove:<id>" while a request runs.
	let pending = $state<string | null>(null);
	let status = $state('');
	let error = $state('');
	let confirmingId = $state<string | null>(null);
	// When each domain can be checked again, in epoch milliseconds. The API allows one check a
	// minute per domain, so the button counts down instead of failing.
	let cooldowns = $state<Record<string, number>>({});
	let now = $state(Date.now());

	$effect(() => {
		if (Object.keys(cooldowns).length === 0) return;
		const timer = setInterval(() => {
			now = Date.now();
			const waiting = Object.entries(cooldowns).filter(([, until]) => until > now);
			if (waiting.length !== Object.keys(cooldowns).length) cooldowns = Object.fromEntries(waiting);
		}, 1000);
		return () => clearInterval(timer);
	});

	function secondsLeft(domainId: string): number {
		const until = cooldowns[domainId];
		return until === undefined ? 0 : Math.max(0, Math.ceil((until - now) / 1000));
	}

	function coolDown(domainId: string, seconds: number) {
		now = Date.now();
		cooldowns = { ...cooldowns, [domainId]: now + seconds * 1000 };
	}

	const dates = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
	const numbers = new Intl.NumberFormat();
	const atLimit = $derived(page.used >= page.limit);
	const nearLimit = $derived(!atLimit && page.limit > 0 && page.used / page.limit >= 0.8);
	const workspaceDomains = $derived(page.domains.filter((domain) => domain.kind === 'workspace'));
	const platformDomains = $derived(page.domains.filter((domain) => domain.kind === 'platform'));

	const stateLabels: Record<Domain['state'], string> = {
		pending: 'Waiting for DNS',
		verifying: 'Verifying',
		active: 'Active',
		failed: 'Failed',
		disabled: 'Removed'
	};

	const focusOnMount: Action<HTMLElement> = (node) => {
		node.focus();
	};

	function begin(action: string) {
		pending = action;
		error = '';
		status = '';
	}

	async function add() {
		fieldError = '';
		let normalized: string;
		try {
			normalized = normalizeHostname(hostname);
		} catch (cause) {
			fieldError =
				cause instanceof LinkInputError
					? cause.message
					: 'Enter a hostname such as go.example.com.';
			return;
		}
		begin('add');
		try {
			const result = await addDomain(apiBase, normalized);
			if (!result.ok) {
				if (result.failure.field === 'hostname' || result.failure.code === 'DOMAIN_TAKEN')
					fieldError = domainErrorMessage(result.failure);
				else error = domainErrorMessage(result.failure);
				return;
			}
			hostname = '';
			await onChanged();
			status = `Added ${result.value.hostname}. Add the DNS record shown below.`;
		} finally {
			pending = null;
		}
	}

	async function check(domain: Domain) {
		begin(`check:${domain.id}`);
		try {
			const result = await checkDomain(apiBase, domain.id);
			if (!result.ok) {
				if (result.failure.code === 'DOMAIN_CHECK_TOO_SOON')
					coolDown(domain.id, result.failure.retryAfterSeconds ?? domainCheckIntervalMs / 1000);
				else error = domainErrorMessage(result.failure);
				return;
			}
			coolDown(domain.id, domainCheckIntervalMs / 1000);
			await onChanged();
			status =
				result.value.state === 'active'
					? `${domain.hostname} is active.`
					: `Checked ${domain.hostname}: ${stateLabels[result.value.state].toLowerCase()}.`;
		} finally {
			pending = null;
		}
	}

	async function remove(domain: Domain) {
		begin(`remove:${domain.id}`);
		try {
			const result = await removeDomain(apiBase, domain.id);
			confirmingId = null;
			if (!result.ok && result.failure.code !== 'NOT_FOUND') {
				error = domainErrorMessage(result.failure);
				return;
			}
			await onChanged();
			status = `Removed ${domain.hostname}.`;
		} finally {
			pending = null;
		}
	}

	async function copy(value: string, label: string) {
		try {
			await navigator.clipboard.writeText(value);
			status = `${label} copied.`;
		} catch {
			status = `Select the ${label.toLowerCase()} and copy it.`;
		}
	}

	function stopping(count: number | null): string {
		if (!count) return 'No active links use this domain.';
		return count === 1
			? '1 active link on this domain will stop working.'
			: `${numbers.format(count)} active links on this domain will stop working.`;
	}
</script>

<section class="domains" aria-labelledby="domains-heading" aria-busy={pending !== null}>
	<h2 id="domains-heading">Custom domains</h2>
	<p class="lead">
		Use your own subdomain for short links. Links on a custom domain work after the domain is
		active.
	</p>
	<p class="usage" class:warn={atLimit || nearLimit}>
		{#if page.limit === 0}Custom domains are not available in this workspace.{:else}{numbers.format(
				page.used
			)} of {numbers.format(page.limit)} custom domains used{#if atLimit}. You have used all your
				custom domains.{:else if nearLimit}. You are close to your custom domain limit.{/if}{/if}
	</p>
	<p class="status" role="status" aria-live="polite">{status}</p>
	{#if error}<p class="error" role="alert">{error}</p>{/if}

	{#if workspaceDomains.length === 0}
		<EmptyState>No custom domains yet.</EmptyState>
	{:else}
		<ul aria-label="Your custom domains">
			{#each workspaceDomains as domain (domain.id)}
				<li>
					<div class="head">
						<span class="tile" aria-hidden="true"
							><svg viewBox="0 0 24 24"
								><circle cx="12" cy="12" r="9" /><path
									d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z"
								/></svg
							></span
						>
						<span class="name">{domain.hostname}</span>
						<span class="badge {domain.state}">{stateLabels[domain.state]}</span>
					</div>
					{#if domain.error}<p class="error">{domain.error.message}</p>{/if}
					{#if domain.state === 'active'}
						<p class="meta">
							{#if domain.activatedAt}Active since <time datetime={domain.activatedAt}
									>{dates.format(new Date(domain.activatedAt))}</time
								>.
							{/if}Keep the DNS record in place so your links keep working.
						</p>
					{:else}
						<p class="meta">
							At your DNS provider, add the CNAME record below. If your DNS is on Cloudflare, set
							the proxy status to DNS only.
						</p>
						<p class="meta">
							Checks run automatically; the certificate is usually ready within an hour.
						</p>
					{/if}
					{#if domain.records.length > 0}
						<table>
							<caption class="visually-hidden">DNS record for {domain.hostname}</caption>
							<thead>
								<tr
									><th scope="col">Type</th><th scope="col">Name</th><th scope="col">Target</th></tr
								>
							</thead>
							<tbody>
								{#each domain.records as dnsRecord (`${dnsRecord.type}:${dnsRecord.name}`)}
									<tr>
										<td data-label="Type"><code>{dnsRecord.type}</code></td>
										<td data-label="Name">
											<span class="cell">
												<code>{dnsRecord.name}</code>
												<button
													type="button"
													class="copy"
													aria-label={`Copy name for ${domain.hostname}`}
													onclick={() => void copy(dnsRecord.name, 'Name')}>Copy</button
												>
											</span>
										</td>
										<td data-label="Target">
											<span class="cell">
												<code>{dnsRecord.value}</code>
												<button
													type="button"
													class="copy"
													aria-label={`Copy target for ${domain.hostname}`}
													onclick={() => void copy(dnsRecord.value, 'Target')}>Copy</button
												>
											</span>
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					{/if}
					<div class="actions">
						{#if confirmingId === domain.id}
							<p class="confirm">
								Remove {domain.hostname}? {stopping(domain.activeLinks)}
							</p>
							<button
								type="button"
								class="danger"
								disabled={pending !== null}
								onclick={() => void remove(domain)}
								>{pending === `remove:${domain.id}` ? 'Removing…' : 'Remove'}</button
							>
							<button
								type="button"
								use:focusOnMount
								disabled={pending !== null}
								onclick={() => (confirmingId = null)}>Keep</button
							>
						{:else}
							{#if domain.state !== 'active'}
								{@const wait = secondsLeft(domain.id)}
								<button
									type="button"
									disabled={pending !== null || wait > 0}
									aria-label={wait > 0
										? `Check ${domain.hostname} again in ${wait} seconds`
										: `Check ${domain.hostname} now`}
									onclick={() => void check(domain)}
									>{pending === `check:${domain.id}`
										? 'Checking…'
										: wait > 0
											? `Check again in ${wait}s`
											: 'Check now'}</button
								>
							{/if}
							<button
								type="button"
								disabled={pending !== null}
								aria-label={`Remove ${domain.hostname}`}
								onclick={() => (confirmingId = domain.id)}>Remove</button
							>
						{/if}
					</div>
				</li>
			{/each}
		</ul>
	{/if}

	{#if atLimit && page.limit > 0}
		<p class="empty">To add another domain, remove one first.</p>
	{:else if !atLimit}
		<form
			class="add"
			novalidate
			onsubmit={(event) => {
				event.preventDefault();
				void add();
			}}
		>
			<h3>Add a domain</h3>
			<div class="field">
				<label for="domain-hostname">Hostname</label>
				<input
					id="domain-hostname"
					bind:value={hostname}
					type="text"
					inputmode="url"
					autocomplete="off"
					autocapitalize="none"
					spellcheck="false"
					maxlength="253"
					placeholder="go.example.com"
					required
					aria-invalid={fieldError ? true : undefined}
					aria-describedby={fieldError
						? 'domain-hostname-error domain-hostname-hint'
						: 'domain-hostname-hint'}
				/>
				<p id="domain-hostname-hint" class="hint">A subdomain such as go.example.com</p>
				{#if fieldError}<p id="domain-hostname-error" class="error" role="alert">
						{fieldError}
					</p>{/if}
			</div>
			<button type="submit" class="primary" disabled={pending !== null}
				>{pending === 'add' ? 'Adding…' : 'Add domain'}</button
			>
		</form>
	{/if}

	{#if platformDomains.length > 0}
		<h3>Included domains</h3>
		<ul aria-label="Included domains">
			{#each platformDomains as domain (domain.id)}
				<li>
					<div class="head">
						<span class="tile" aria-hidden="true"
							><svg viewBox="0 0 24 24"
								><circle cx="12" cy="12" r="9" /><path
									d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z"
								/></svg
							></span
						>
						<span class="name">{domain.hostname}</span>
						<span class="badge active">{domain.isDefault ? 'Default' : 'Active'}</span>
					</div>
					<p class="meta">Every workspace can use this domain. It needs no setup.</p>
				</li>
			{/each}
		</ul>
	{/if}
</section>

<style>
	.domains {
		display: grid;
		gap: 0.75rem;
		max-width: 44rem;
	}
	h2 {
		font-size: 1.05rem;
	}
	h3 {
		margin-top: 0.5rem;
		font-size: 0.95rem;
	}
	.lead,
	.status,
	.empty,
	.meta,
	.hint,
	.usage {
		color: var(--color-muted, #667085);
		font-size: 0.85rem;
	}
	.usage {
		font-variant-numeric: tabular-nums;
	}
	.usage.warn {
		color: var(--color-strong, #101828);
		font-weight: 600;
	}
	.status:empty {
		display: none;
	}
	.error {
		color: var(--color-danger, #b42318);
		font-size: 0.85rem;
	}
	ul {
		display: grid;
		margin: 0;
		padding: 0;
		list-style: none;
		border: 1px solid var(--color-rule, #d0d5dd);
		border-radius: var(--radius-md, 8px);
		background: var(--color-paper, #fff);
	}
	li {
		display: grid;
		gap: 0.6rem;
		min-width: 0;
		padding: 1rem;
	}
	li + li {
		border-top: 1px solid var(--color-rule, #d0d5dd);
	}
	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem 0.75rem;
	}
	.name {
		color: var(--color-strong, #101828);
		font-weight: 650;
		overflow-wrap: anywhere;
	}
	.tile {
		display: grid;
		flex: none;
		place-items: center;
		width: 2.25rem;
		height: 2.25rem;
		border-radius: var(--radius-md, 8px);
		background: var(--color-tile-teal-soft, #f0fdfa);
		color: var(--color-tile-teal, #0f766e);
	}
	.tile svg {
		width: 1.25rem;
		height: 1.25rem;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.6;
	}
	/* Each state has a colour and its name, so colour is never the only signal. */
	.badge {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		padding: 0.1rem 0.55rem;
		border-radius: 999px;
		background: var(--color-surface, #f9fafb);
		color: var(--color-muted, #667085);
		box-shadow: inset 0 0 0 1px var(--color-rule, #d0d5dd);
		font-size: 0.75rem;
		font-weight: 600;
	}
	.badge::before {
		width: 0.45rem;
		height: 0.45rem;
		border-radius: 50%;
		background: currentColor;
		content: '';
	}
	.badge.active {
		background: var(--color-positive-soft, #ecfdf3);
		color: var(--color-positive, #067647);
		box-shadow: none;
	}
	.badge.pending,
	.badge.verifying {
		background: var(--color-warning-soft, #fffaeb);
		color: var(--color-warning, #b54708);
		box-shadow: none;
	}
	.badge.failed {
		background: var(--color-danger-soft, #fef3f2);
		color: var(--color-danger, #b42318);
		box-shadow: none;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		table-layout: fixed;
		font-size: 0.85rem;
	}
	th {
		padding: 0.4rem 0.5rem;
		color: var(--color-muted, #667085);
		font-size: 0.75rem;
		font-weight: 600;
		text-align: left;
	}
	th:first-child {
		width: 5rem;
	}
	td {
		padding: 0.5rem;
		border-top: 1px solid var(--color-rule, #d0d5dd);
		vertical-align: middle;
	}
	.cell {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
	}
	code {
		min-width: 0;
		color: var(--color-ink, #101828);
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 0.8rem;
		overflow-wrap: anywhere;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
	}
	.confirm {
		flex-basis: 100%;
		color: var(--color-strong, #101828);
		font-size: 0.85rem;
	}
	.add {
		display: grid;
		gap: 0.75rem;
		max-width: 28rem;
		margin-top: 0.5rem;
	}
	.field {
		display: grid;
		gap: 0.4rem;
	}
	label {
		color: var(--color-strong, #101828);
		font-size: 0.85rem;
		font-weight: 650;
	}
	input {
		width: 100%;
		min-width: 0;
		min-height: 44px;
		padding: 0.6rem 0.8rem;
		color: var(--color-ink, #101828);
		border: 1px solid var(--color-rule, #d0d5dd);
		border-radius: var(--radius-sm, 6px);
		background: var(--color-paper, #fff);
	}
	input:focus-visible {
		border-color: var(--color-muted, #667085);
		outline: 1px solid var(--color-muted, #667085);
		outline-offset: -1px;
	}
	input[aria-invalid='true'] {
		border-color: var(--color-danger, #b42318);
	}
	button {
		min-height: 44px;
		padding: 0.4rem 0.9rem;
		border: 1px solid var(--color-rule, #d0d5dd);
		border-radius: var(--radius-sm, 6px);
		background: var(--color-paper, #fff);
		color: var(--color-ink, #101828);
		font-size: 0.8rem;
		font-weight: 600;
	}
	button:hover:not(:disabled) {
		border-color: var(--color-muted, #667085);
	}
	button.primary {
		justify-self: start;
		padding: 0.65rem 1.15rem;
		border-color: var(--color-button-primary, #101828);
		background: var(--color-button-primary, #101828);
		color: var(--color-on-primary, #fff);
		font-size: inherit;
		font-weight: 620;
	}
	button.primary:hover:not(:disabled) {
		background: var(--color-button-primary-hover, #344054);
		border-color: var(--color-button-primary-hover, #344054);
	}
	button.danger,
	button.danger:hover:not(:disabled) {
		border-color: var(--color-button-danger, #b42318);
		background: var(--color-button-danger, #b42318);
		color: var(--color-on-primary, #fff);
	}
	button:disabled {
		color: var(--color-muted, #667085);
		background: var(--color-disabled, #eaecf0);
		border-color: var(--color-disabled, #eaecf0);
	}
	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: nowrap;
	}
	@media (max-width: 40rem) {
		thead {
			position: absolute;
			width: 1px;
			height: 1px;
			overflow: hidden;
			clip: rect(0 0 0 0);
		}
		tr,
		td {
			display: block;
		}
		td::before {
			content: attr(data-label);
			display: block;
			margin-bottom: 0.2rem;
			color: var(--color-muted, #667085);
			font-size: 0.75rem;
			font-weight: 600;
		}
		button.primary {
			justify-self: stretch;
		}
	}
</style>
