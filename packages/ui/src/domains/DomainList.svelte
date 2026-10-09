<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { Action } from 'svelte/action';
	import Glyph from '../icons/Glyph.svelte';
	import Panel from '../layout/Panel.svelte';
	import Tile from '../layout/Tile.svelte';
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
		// The page title, shown left of the usage and the Add domain button.
		heading?: Snippet;
		// Where the full setup steps are, such as the edition's docs page.
		guideHref?: string;
	}

	let { page, apiBase, onChanged, heading, guideHref }: Props = $props();
	let adding = $state(false);
	let hostnameInput = $state<HTMLInputElement>();

	async function openAdd() {
		adding = true;
		await Promise.resolve();
		hostnameInput?.focus();
	}

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
	// The add form opens from the button at the top; with no custom domain it is always open.
	const showAdd = $derived(!atLimit && (adding || workspaceDomains.length === 0));

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
			adding = false;
			await onChanged();
			status =
				result.value.setup === 'worker_custom_domain'
					? `Added ${result.value.hostname}. Follow the steps shown below.`
					: `Added ${result.value.hostname}. Add the DNS record shown below.`;
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

	function stateLabel(domain: Domain): string {
		return domain.state === 'pending' && domain.setup === 'worker_custom_domain'
			? 'Waiting for setup'
			: stateLabels[domain.state];
	}

	function stopping(count: number | null): string {
		if (!count) return 'No active links use this domain.';
		return count === 1
			? '1 active link on this domain will stop working.'
			: `${numbers.format(count)} active links on this domain will stop working.`;
	}
</script>

<section class="domains" aria-label="Domains" aria-busy={pending !== null}>
	<div class="top">
		{#if heading}<div class="heading">{@render heading()}</div>{/if}
		<div class="limit">
			{#if !showAdd}
				<button
					type="button"
					class="primary"
					disabled={atLimit || pending !== null}
					onclick={() => void openAdd()}><Glyph name="plus" size={18} />Add domain</button
				>
			{/if}
			<p class="usage" class:warn={atLimit || nearLimit}>
				{#if page.limit === 0}Custom domains are not available in this workspace.{:else}{numbers.format(
						page.used
					)} of {numbers.format(page.limit)} custom domains used{/if}
			</p>
		</div>
	</div>
	<p class="status" role="status" aria-live="polite">{status}</p>
	{#if error}<p class="error" role="alert">{error}</p>{/if}

	{#if showAdd}
		<Panel
			id="domain-add-heading"
			title="Add a custom domain"
			lead="Use your own subdomain for short links. Links on it work after the domain is active."
			icon="globe"
			tone="teal"
		>
			<form
				class="add"
				novalidate
				onsubmit={(event) => {
					event.preventDefault();
					void add();
				}}
			>
				<label for="domain-hostname">Hostname</label>
				<div class="add-row">
					<input
						id="domain-hostname"
						bind:this={hostnameInput}
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
					<button type="submit" class="primary" disabled={pending !== null}
						>{pending === 'add' ? 'Adding…' : 'Add domain'}</button
					>
					{#if workspaceDomains.length > 0}
						<button type="button" disabled={pending !== null} onclick={() => (adding = false)}
							>Cancel</button
						>
					{/if}
				</div>
				<p id="domain-hostname-hint" class="hint">
					A subdomain such as go.example.com. Root domains such as example.com are not supported.
				</p>
				{#if fieldError}<p id="domain-hostname-error" class="error" role="alert">
						{fieldError}
					</p>{/if}
			</form>
		</Panel>
	{/if}

	<Panel id="domains-heading" title="Your domains">
		<ul>
			{#each platformDomains as domain (domain.id)}
				<li>
					<Tile icon="globe" tone="teal" large />
					<div class="main">
						<span class="head">
							<span class="name">{domain.hostname}</span>
							<span class="tag">Included</span>
							<span class="badge active">{domain.isDefault ? 'Default' : 'Active'}</span>
						</span>
						<span class="meta">Ready to use. No setup needed.</span>
					</div>
				</li>
			{/each}
			{#each workspaceDomains as domain (domain.id)}
				<li>
					<Tile icon="globe" tone="teal" large />
					<div class="main">
						<span class="head">
							<span class="name">{domain.hostname}</span>
							<span class="badge {domain.state}">{stateLabel(domain)}</span>
						</span>
						<span class="meta">
							{#if domain.state === 'active'}
								{#if domain.activatedAt}Active since <time datetime={domain.activatedAt}
										>{dates.format(new Date(domain.activatedAt))}</time
									>.
								{/if}{domain.setup === 'worker_custom_domain'
									? 'Keep the Custom Domain in place so your links keep working.'
									: 'Keep the DNS record in place so your links keep working.'}
							{:else if domain.state === 'failed'}
								{domain.error?.message ?? 'The last check failed.'} See the steps below.
							{:else}
								Finish the setup below.
							{/if}
						</span>
					</div>
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
		{#if atLimit && page.limit > 0}
			<p class="meta">You have used all your custom domains. To add another, remove one first.</p>
		{:else if nearLimit}
			<p class="meta">You are close to your custom domain limit.</p>
		{/if}
	</Panel>

	{#each workspaceDomains.filter((domain) => domain.state !== 'active' && domain.state !== 'disabled') as domain (domain.id)}
		{@const step = domain.state === 'verifying' ? 3 : 2}
		{@const worker = domain.setup === 'worker_custom_domain'}
		{@const wait = secondsLeft(domain.id)}
		<Panel
			id={`connect-${domain.id}`}
			title={`Connect ${domain.hostname}`}
			lead={worker
				? 'Add it as a Custom Domain of this Worker in Cloudflare.'
				: 'Add this record at your DNS provider.'}
		>
			<ol class="progress" aria-label="Setup steps">
				<li class="done">
					<span class="dot"><Glyph name="check" size={16} /></span>
					<span><strong>Add domain</strong><span>Domain added</span></span>
				</li>
				<li
					class:done={step > 2}
					class:current={step === 2}
					aria-current={step === 2 ? 'step' : undefined}
				>
					<span class="dot"
						>{#if step > 2}<Glyph name="check" size={16} />{:else}2{/if}</span
					>
					<span
						><strong>{worker ? 'Add the Custom Domain' : 'Configure DNS'}</strong><span
							>{worker ? 'In the Cloudflare dashboard' : 'Add the DNS record'}</span
						></span
					>
				</li>
				<li class:current={step === 3} aria-current={step === 3 ? 'step' : undefined}>
					<span class="dot">3</span>
					<span><strong>Verify</strong><span>Check the connection</span></span>
				</li>
			</ol>

			{#if worker}
				<ol class="meta steps">
					<li>
						In the Cloudflare dashboard, open <strong>Workers &amp; Pages</strong> and select this Flared
						Worker.
					</li>
					<li>
						Open <strong>Settings → Domains &amp; Routes</strong>, choose <strong>Add</strong>, then
						<strong>Custom domain</strong>.
					</li>
					<li>
						<span class="cell"
							>Enter <code>{domain.hostname}</code>
							<button
								type="button"
								class="copy"
								aria-label={`Copy ${domain.hostname}`}
								onclick={() => void copy(domain.hostname, 'Hostname')}
								><Glyph name="copy" size={16} /></button
							></span
						>
					</li>
				</ol>
				<p class="meta">The domain must be on Cloudflare in the same account as this Worker.</p>
			{/if}
			{#if domain.records.length > 0}
				<div class="record">
					<table>
						<caption>DNS record</caption>
						<thead>
							<tr><th scope="col">Type</th><th scope="col">Name</th><th scope="col">Target</th></tr>
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
												onclick={() => void copy(dnsRecord.name, 'Name')}
												><Glyph name="copy" size={16} /></button
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
												onclick={() => void copy(dnsRecord.value, 'Target')}
												><Glyph name="copy" size={16} /></button
											>
										</span>
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
				<p class="meta">If your DNS is on Cloudflare, set the proxy status to DNS only.</p>
			{/if}

			<div class="state {domain.state}">
				<Glyph name={domain.state === 'failed' ? 'warning' : 'clock'} size={24} />
				<p>
					{#if domain.state === 'failed'}
						<strong>The last check failed</strong>
						<span>{domain.error?.message ?? 'Check the setup above, then check again.'}</span>
					{:else if domain.state === 'verifying'}
						<strong>Verifying</strong>
						<span
							>The record is in place. The HTTPS certificate is usually ready within an hour.</span
						>
					{:else}
						<strong>{worker ? 'Waiting for setup' : 'Waiting for the DNS record'}</strong>
						<span
							>{worker
								? 'Checks run automatically every 10 minutes.'
								: 'Checks run automatically. Changes at your DNS provider can take some time to appear.'}</span
						>
					{/if}
				</p>
			</div>

			<div class="actions">
				<button
					type="button"
					class="primary"
					disabled={pending !== null || wait > 0}
					aria-label={wait > 0
						? `Check ${domain.hostname} again in ${wait} seconds`
						: `Check ${domain.hostname} now`}
					onclick={() => void check(domain)}
					>{pending === `check:${domain.id}`
						? 'Checking…'
						: wait > 0
							? `Check again in ${wait}s`
							: 'Check connection'}</button
				>
				{#if guideHref}
					<a class="guide" href={guideHref}>View setup guide <Glyph name="arrow" size={16} /></a>
				{/if}
			</div>
			<p class="foot">
				<Glyph name="lock" size={18} />Links on this domain work when verification completes.
			</p>
		</Panel>
	{/each}
</section>

<style>
	.domains {
		display: grid;
		gap: 1.25rem;
		max-width: 64rem;
	}
	.top {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
	}
	.heading {
		min-width: 0;
	}
	.limit {
		display: grid;
		justify-items: end;
		gap: 0.4rem;
		margin-left: auto;
	}
	.usage,
	.status,
	.meta,
	.hint {
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
	}
	ul > li {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.75rem 1rem;
		padding: 1rem 0;
	}
	ul > li + li {
		border-top: 1px solid var(--color-rule, #eaecf0);
	}
	ul > li:first-child {
		padding-top: 0.25rem;
	}
	.main {
		display: grid;
		flex: 1 1 14rem;
		gap: 0.25rem;
		min-width: 0;
	}
	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.4rem 0.6rem;
	}
	.name {
		color: var(--color-strong, #101828);
		font-size: 1.05rem;
		font-weight: 650;
		overflow-wrap: anywhere;
	}
	.tag {
		padding: 0.1rem 0.5rem;
		border-radius: var(--radius-sm, 6px);
		color: var(--color-ink, #344054);
		box-shadow: inset 0 0 0 1px var(--color-rule, #d0d5dd);
		font-size: 0.75rem;
		font-weight: 550;
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
	.progress {
		display: grid;
		gap: 0.75rem;
		margin: 0.25rem 0;
		padding: 0;
		list-style: none;
		counter-reset: none;
	}
	@media (min-width: 48rem) {
		.progress {
			grid-template-columns: repeat(3, minmax(0, 1fr));
		}
	}
	.progress li {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}
	.progress li > span:last-child {
		display: grid;
		gap: 0.1rem;
	}
	.progress strong {
		color: var(--color-strong, #101828);
		font-size: 0.95rem;
		font-weight: 600;
	}
	.progress li > span:last-child > span {
		color: var(--color-muted, #667085);
		font-size: 0.85rem;
	}
	.dot {
		display: grid;
		flex: none;
		place-items: center;
		width: 2.25rem;
		height: 2.25rem;
		border-radius: 50%;
		color: var(--color-ink, #344054);
		box-shadow: inset 0 0 0 1px var(--color-rule, #d0d5dd);
		font-weight: 650;
	}
	.done .dot {
		background: var(--color-positive, #067647);
		color: var(--color-on-primary, #fff);
		box-shadow: none;
	}
	.current .dot {
		background: var(--color-button-primary, #c94b00);
		color: var(--color-on-primary, #fff);
		box-shadow: none;
	}
	.steps {
		display: grid;
		gap: 0.35rem;
		margin: 0;
		padding-left: 1.25rem;
	}
	.record {
		overflow: hidden;
		border: 1px solid var(--color-rule, #eaecf0);
		border-radius: var(--radius-md, 8px);
	}
	table {
		width: 100%;
		border-collapse: collapse;
		table-layout: fixed;
		font-size: 0.9rem;
	}
	caption {
		padding: 0.75rem 1rem;
		background: var(--color-disabled, #f9fafb);
		color: var(--color-strong, #101828);
		font-weight: 650;
		text-align: left;
	}
	th {
		padding: 0.5rem 1rem;
		border-top: 1px solid var(--color-rule, #eaecf0);
		background: var(--color-disabled, #f9fafb);
		color: var(--color-muted, #667085);
		font-size: 0.8rem;
		font-weight: 600;
		text-align: left;
	}
	th:first-child {
		width: 6rem;
	}
	td {
		padding: 0.6rem 1rem;
		border-top: 1px solid var(--color-rule, #eaecf0);
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
		font-size: 0.85rem;
		overflow-wrap: anywhere;
	}
	.state {
		display: flex;
		align-items: flex-start;
		gap: 0.85rem;
		padding: 1rem 1.25rem;
		border-radius: var(--radius-md, 8px);
		background: var(--color-warning-soft, #fffaeb);
		color: var(--color-warning, #b54708);
	}
	.state.failed {
		background: var(--color-danger-soft, #fef3f2);
		color: var(--color-danger, #b42318);
	}
	.state :global(svg) {
		flex: none;
	}
	.state p {
		display: grid;
		gap: 0.15rem;
	}
	.state strong {
		color: var(--color-strong, #101828);
		font-weight: 650;
	}
	.state span {
		color: var(--color-ink, #344054);
		font-size: 0.875rem;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem 1rem;
	}
	.confirm {
		flex-basis: 100%;
		color: var(--color-strong, #101828);
		font-size: 0.85rem;
	}
	.guide {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		min-height: 44px;
		color: var(--color-accent-ink, #b93815);
		font-weight: 600;
	}
	.guide:hover {
		text-decoration: underline;
	}
	.foot {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		padding-top: 0.9rem;
		border-top: 1px solid var(--color-rule, #eaecf0);
		color: var(--color-muted, #667085);
		font-size: 0.85rem;
	}
	.add {
		display: grid;
		gap: 0.4rem;
	}
	.add-row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}
	.add-row input {
		flex: 1 1 16rem;
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
		background: var(--color-input, #fff);
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
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.4rem;
		min-height: 44px;
		padding: 0.4rem 0.9rem;
		border: 1px solid var(--color-rule, #d0d5dd);
		border-radius: var(--radius-sm, 6px);
		background: var(--color-paper, #fff);
		color: var(--color-ink, #101828);
		font-size: 0.85rem;
		font-weight: 600;
	}
	button:hover:not(:disabled) {
		border-color: var(--color-muted, #667085);
	}
	button.copy {
		min-width: 40px;
		min-height: 40px;
		padding: 0;
	}
	button.primary {
		padding: 0.65rem 1.25rem;
		border-color: var(--color-button-primary, #101828);
		background: var(--color-button-primary, #101828);
		color: var(--color-on-primary, #fff);
		font-size: 0.9rem;
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
		.limit {
			justify-items: start;
			margin-left: 0;
		}
	}
</style>
