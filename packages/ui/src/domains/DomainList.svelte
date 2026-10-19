<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import { tick } from 'svelte';
	import Glyph from '../icons/Glyph.svelte';
	import Button from '../atoms/Button.svelte';
	import PageHeader from '../molecules/PageHeader.svelte';
	import type { Crumb } from '../molecules/Breadcrumbs.svelte';
	import Callout from '../molecules/Callout.svelte';
	import Dialog from '../molecules/Dialog.svelte';
	import DomainAddForm from './DomainAddForm.svelte';
	import DomainCard from './DomainCard.svelte';
	import { shownWorkspace } from '../workspace/shown';
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
		// Where the full setup steps are, such as the edition's docs page.
		guideHref?: string;
		// The breadcrumb above the page title.
		crumbs?: Crumb[];
		// The links page, and the links page filtered to one domain.
		createHref?: string;
		linksHref?: (domain: Domain) => string;
		// Only the owner adds, checks, and removes domains; a member sees them.
		manage?: boolean;
	}

	let {
		page,
		apiBase,
		onChanged,
		guideHref,
		crumbs,
		createHref,
		linksHref,
		manage = true
	}: Props = $props();
	const workspace = shownWorkspace();

	let subdomain = $state('');
	let domain = $state('');
	let hostnameInput = $state<HTMLInputElement>();
	let fieldError = $state('');
	let errorField = $state<'subdomain' | 'domain' | null>(null);
	let adding = $state(false);
	// "add", "check:<id>", or "remove:<id>" while a request runs.
	let pending = $state<string | null>(null);
	let status = $state('');
	let error = $state('');
	let confirming = $state<Domain | null>(null);
	let confirmOpen = $state(false);
	// When each domain can be checked again, in epoch milliseconds. The API allows one check a
	// minute per domain, so the button counts down instead of failing.
	let cooldowns = $state<Record<string, number>>({});
	let lastChecks = $state<Record<string, { at: number; state: Domain['state'] }>>({});
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

	const numbers = new Intl.NumberFormat();
	const atLimit = $derived(page.used >= page.limit);
	const nearLimit = $derived(!atLimit && page.limit > 0 && page.used / page.limit >= 0.8);
	const workspaceDomains = $derived(page.domains.filter((domain) => domain.kind === 'workspace'));
	const platformDomains = $derived(page.domains.filter((domain) => domain.kind === 'platform'));
	const empty = $derived(workspaceDomains.length === 0);
	const firstSetup = $derived(!workspaceDomains.some((domain) => domain.state === 'active'));
	const canAdd = $derived(manage && page.limit > 0);

	const checkOutcomes: Record<Domain['state'], string> = {
		pending: 'not ready yet',
		verifying: 'verifying',
		active: 'active',
		failed: 'setup failed',
		disabled: 'removed'
	};

	function begin(action: string) {
		pending = action;
		error = '';
		status = '';
	}

	async function openAdd() {
		refuse('', null);
		adding = true;
		await tick();
		hostnameInput?.focus();
	}

	// The field that holds the error, so only that field shows it.
	function refuse(message: string, field: 'subdomain' | 'domain' | null) {
		fieldError = message;
		errorField = field;
	}

	// Moves focus to a card, so a keyboard or screen reader lands on the domain that changed.
	async function focusCard(domainId: string) {
		await tick();
		const heading = document.getElementById(`domain-${domainId}`);
		heading?.focus({ preventScroll: true });
		heading?.scrollIntoView({ block: 'nearest' });
	}

	async function add() {
		refuse('', null);
		const trimDots = (value: string) =>
			value
				.trim()
				.toLowerCase()
				.replace(/^\.+|\.+$/g, '');
		const label = trimDots(subdomain);
		const base = trimDots(domain);
		if (!label) return refuse('Enter a subdomain, such as go.', 'subdomain');
		// www usually serves the website, which a short-link domain would replace.
		if (label === 'www')
			return refuse(
				'Use a subdomain other than www, such as go or links. www usually shows your website.',
				'subdomain'
			);
		if (!base) return refuse('Enter your domain, such as yourbrand.com.', 'domain');
		if (!base.includes('.'))
			return refuse('Enter your full domain, such as yourbrand.com.', 'domain');
		let normalized: string;
		try {
			normalized = normalizeHostname(`${label}.${base}`);
		} catch (cause) {
			return refuse(
				cause instanceof LinkInputError
					? cause.message
					: 'Enter a hostname such as go.example.com.',
				null
			);
		}
		begin('add');
		try {
			const result = await addDomain(apiBase, normalized, workspace());
			if (!result.ok) {
				if (result.failure.field === 'hostname' || result.failure.code === 'DOMAIN_TAKEN')
					refuse(domainErrorMessage(result.failure), null);
				else error = domainErrorMessage(result.failure);
				return;
			}
			subdomain = '';
			domain = '';
			adding = false;
			await onChanged();
			status =
				result.value.setup === 'worker_custom_domain'
					? `Added ${result.value.hostname}. Follow the steps in its card.`
					: `Added ${result.value.hostname}. Add the DNS record in its card.`;
			await focusCard(result.value.id);
		} finally {
			pending = null;
		}
	}

	async function check(domain: Domain) {
		begin(`check:${domain.id}`);
		try {
			const result = await checkDomain(apiBase, domain.id, workspace());
			if (!result.ok) {
				if (result.failure.code === 'DOMAIN_CHECK_TOO_SOON')
					coolDown(domain.id, result.failure.retryAfterSeconds ?? domainCheckIntervalMs / 1000);
				else error = domainErrorMessage(result.failure);
				return;
			}
			coolDown(domain.id, domainCheckIntervalMs / 1000);
			lastChecks = { ...lastChecks, [domain.id]: { at: Date.now(), state: result.value.state } };
			await onChanged();
			status =
				result.value.state === 'active'
					? `${domain.hostname} is active.`
					: `Checked ${domain.hostname}: ${checkOutcomes[result.value.state]}.`;
		} finally {
			pending = null;
		}
	}

	function askRemove(domain: Domain) {
		confirming = domain;
		confirmOpen = true;
	}

	async function remove(domain: Domain) {
		begin(`remove:${domain.id}`);
		try {
			const result = await removeDomain(apiBase, domain.id, workspace());
			confirmOpen = false;
			if (!result.ok && result.failure.code !== 'NOT_FOUND') {
				error = domainErrorMessage(result.failure);
				return;
			}
			await onChanged();
			status = `Removed ${domain.hostname}.`;
			const next = page.domains[0];
			if (next) await focusCard(next.id);
		} finally {
			pending = null;
		}
	}

	function stopping(count: number | null): string {
		if (!count) return 'No active links use this domain.';
		return count === 1
			? '1 active link on this domain will stop working.'
			: `${numbers.format(count)} active links on this domain will stop working.`;
	}
</script>

{#snippet usage()}
	<span class="usage" class:warn={atLimit || nearLimit}>
		{#if page.limit === 0}Custom domains are not available in this workspace.{:else}{numbers.format(
				page.used
			)} of {numbers.format(page.limit)} custom domains used{/if}
	</span>
{/snippet}

{#snippet card(domain: Domain)}
	<li>
		<DomainCard
			{domain}
			{firstSetup}
			lastCheck={lastChecks[domain.id] ?? null}
			checking={pending === `check:${domain.id}`}
			wait={secondsLeft(domain.id)}
			busy={pending !== null}
			{guideHref}
			{createHref}
			linksHref={linksHref?.(domain)}
			oncheck={manage ? () => void check(domain) : undefined}
			onremove={manage ? () => askRemove(domain) : undefined}
		/>
	</li>
{/snippet}

<PageHeader {crumbs} title="Domains">
	{#snippet top()}{@render usage()}{/snippet}
	{#snippet aside()}
		{#if canAdd && !empty}
			<Button
				size="sm"
				variant="primary"
				icon="plus"
				disabled={atLimit || pending !== null}
				onclick={() => void openAdd()}>Add<span class="wide-label">&nbsp;domain</span></Button
			>
		{/if}
	{/snippet}
</PageHeader>

<div class="domains" aria-busy={pending !== null}>
	<p class="visually-hidden" role="status" aria-live="polite">{status}</p>
	{#if error}<Callout tone="danger" role="alert"><p>{error}</p></Callout>{/if}

	{#if empty}
		<section class="first" aria-labelledby="domain-first-heading">
			<span class="first-mark" aria-hidden="true"><Glyph name="globe" size={22} /></span>
			<h2 id="domain-first-heading">Add a custom domain</h2>
			{#if page.limit > 0 && !manage}
				<p class="first-lead">Only the workspace owner can add a domain.</p>
			{:else if page.limit > 0}
				<p class="first-lead">Use a subdomain you own, such as go.yourbrand.com.</p>
				<DomainAddForm
					bind:subdomain
					bind:domain
					bind:input={hostnameInput}
					error={fieldError}
					{errorField}
					pending={pending === 'add'}
					disabled={atLimit || pending !== null}
					onsubmit={() => void add()}
				/>
				{#if guideHref}<a class="text-action" href={guideHref}
						>How setup works<Glyph name="arrowUpRight" size={16} /></a
					>{/if}
			{:else}
				<p class="first-lead">Custom domains are not available in this workspace.</p>
			{/if}
		</section>
		{#if platformDomains.length > 0}
			<section class="available" aria-labelledby="available-heading">
				<h2 id="available-heading" class="small-heading">Already available</h2>
				<ul class="cards">
					{#each platformDomains as domain (domain.id)}{@render card(domain)}{/each}
				</ul>
				{#if page.limit > 0}
					<p class="included">
						<Glyph name="check" size={18} />{page.limit === 1
							? 'One custom domain is included in your plan.'
							: `${numbers.format(page.limit)} custom domains are included in your plan.`}
					</p>
				{/if}
			</section>
		{/if}
	{:else}
		<ul class="cards" aria-label="Domains">
			{#each [...workspaceDomains, ...platformDomains] as domain (domain.id)}{@render card(
					domain
				)}{/each}
		</ul>
		<div class="foot">
			<p>The default domain is preselected when you create a link.</p>
			{#if createHref}<a class="text-action" href={createHref}
					>View all links<Glyph name="arrow" size={16} /></a
				>{/if}
		</div>
		{#if !manage}
			<p class="note">Only the workspace owner can add or remove domains.</p>
		{:else if atLimit && page.limit > 0}
			<p class="note">You have used all your custom domains. To add another, remove one first.</p>
		{:else if nearLimit}
			<p class="note">You are close to your custom domain limit.</p>
		{/if}
	{/if}
</div>

{#if canAdd && !empty}
	<Dialog bind:open={adding} id="domain-add-heading" title="Add a custom domain">
		<DomainAddForm
			bind:subdomain
			bind:domain
			bind:input={hostnameInput}
			error={fieldError}
			{errorField}
			pending={pending === 'add'}
			disabled={atLimit || pending !== null}
			onsubmit={() => void add()}
		/>
	</Dialog>
{/if}

{#if manage}
	<Dialog
		bind:open={confirmOpen}
		id="domain-remove-heading"
		title={confirming ? `Remove ${confirming.hostname}?` : 'Remove domain?'}
	>
		{#if confirming}
			{@const domain = confirming}
			<p class="confirm-text">{stopping(domain.activeLinks)}</p>
			<div class="confirm-actions">
				<Button disabled={pending !== null} onclick={() => (confirmOpen = false)}>Keep</Button>
				<Button variant="danger" disabled={pending !== null} onclick={() => void remove(domain)}
					>{pending === `remove:${domain.id}` ? 'Removing…' : 'Remove'}</Button
				>
			</div>
		{/if}
	</Dialog>
{/if}

<style>
	.domains {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 1.25rem;
		width: min(100%, 56rem);
	}
	.usage {
		color: var(--color-subtle);
		font-size: 0.8125rem;
	}
	.usage.warn {
		color: var(--color-warning);
	}
	/* The button reads "Add" on a phone and keeps the full name for screen readers. */
	.wide-label {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
	.cards {
		display: grid;
		gap: 0.625rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.first {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 0.75rem;
		padding: 1.25rem 1rem;
		border-radius: 0.875rem;
		background: var(--color-surface);
		box-shadow: var(--shadow-ring);
	}
	.first-mark {
		display: grid;
		place-items: center;
		width: 2.5rem;
		height: 2.5rem;
		border-radius: 0.625rem;
		background: var(--color-surface-2);
		color: var(--color-strong);
	}
	.first h2 {
		color: var(--color-strong);
		font-size: 1.25rem;
		font-weight: 600;
		letter-spacing: -0.01em;
	}
	.first-lead {
		color: var(--color-muted);
		font-size: 0.9375rem;
	}
	.small-heading {
		color: var(--color-muted);
		font-size: 0.875rem;
		font-weight: 500;
		letter-spacing: 0;
	}
	.available {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 0.75rem;
	}
	.included {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		color: var(--color-muted);
		font-size: 0.875rem;
	}
	.note,
	.foot p,
	.confirm-text {
		color: var(--color-subtle);
		font-size: 0.875rem;
	}
	.confirm-text {
		color: var(--color-muted);
		font-size: 0.9375rem;
	}
	.text-action {
		display: inline-flex;
		flex: none;
		align-items: center;
		justify-self: start;
		gap: 0.35rem;
		min-height: 2.75rem;
		color: var(--color-link);
		font-size: 0.875rem;
		text-decoration: underline;
		text-underline-offset: 3px;
	}
	.foot {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0 1rem;
		margin-top: -0.5rem;
	}
	/* Base: the confirm buttons share the width, as in a phone sheet. */
	.confirm-actions {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.5rem;
		margin-top: 1rem;
	}
	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
	@media (min-width: 48rem) {
		.wide-label {
			position: static;
			width: auto;
			height: auto;
			overflow: visible;
			clip-path: none;
		}
		.first {
			padding: 1.5rem;
		}
		.confirm-actions {
			display: flex;
			justify-content: flex-end;
		}
	}
</style>
