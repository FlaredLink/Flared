<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import { onMount, tick } from 'svelte';
	import Glyph from '../icons/Glyph.svelte';
	import Button from '../atoms/Button.svelte';
	import Badge from '../atoms/Badge.svelte';
	import StatusDot, { type StatusTone } from '../atoms/StatusDot.svelte';
	import PageHeader from '../molecules/PageHeader.svelte';
	import type { Crumb } from '../molecules/Breadcrumbs.svelte';
	import SplitView from '../molecules/SplitView.svelte';
	import SidePanel from '../molecules/SidePanel.svelte';
	import Callout from '../molecules/Callout.svelte';
	import Menu, { type MenuItem } from '../molecules/Menu.svelte';
	import DomainAddForm from './DomainAddForm.svelte';
	import DomainSetup from './DomainSetup.svelte';
	import DomainDetails from './DomainDetails.svelte';
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
	}

	let { page, apiBase, onChanged, guideHref, crumbs, createHref, linksHref }: Props = $props();

	let hostname = $state('');
	let hostnameInput = $state<HTMLInputElement>();
	let fieldError = $state('');
	let adding = $state(false);
	// "add", "check:<id>", or "remove:<id>" while a request runs.
	let pending = $state<string | null>(null);
	let status = $state('');
	let error = $state('');
	let confirmingId = $state<string | null>(null);
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
	const unfinished = (domain: Domain) =>
		domain.kind === 'workspace' && domain.state !== 'active' && domain.state !== 'disabled';
	const ready = (domain: Domain) => domain.kind === 'platform' || domain.state === 'active';
	const readyHost = $derived(
		(platformDomains.find((domain) => domain.isDefault) ?? platformDomains[0])?.hostname ?? null
	);

	// The setup view opens on its own while a domain waits and none is active yet. Undefined
	// means no choice yet; null means the list.
	let setupChoice = $state<string | null | undefined>(undefined);
	const setupDomain = $derived.by(() => {
		if (setupChoice === null) return null;
		if (setupChoice !== undefined)
			return (
				workspaceDomains.find((domain) => domain.id === setupChoice && unfinished(domain)) ?? null
			);
		return workspaceDomains.some((domain) => domain.state === 'active')
			? null
			: (workspaceDomains.find(unfinished) ?? null);
	});
	const empty = $derived(workspaceDomains.length === 0);

	let selectedId = $state<string | null>(null);
	const selected = $derived(
		setupDomain
			? null
			: (page.domains.find((domain) => domain.id === selectedId && ready(domain)) ?? null)
	);

	// With room for two columns, the first active domain opens in the panel, as in the mockups.
	onMount(() => {
		if (empty || !window.matchMedia('(min-width: 75rem)').matches) return;
		const first =
			workspaceDomains.find((domain) => domain.state === 'active') ?? platformDomains[0];
		if (first) selectedId = first.id;
	});

	const lead = $derived(
		setupDomain
			? 'Finish connecting your subdomain.'
			: empty
				? 'Use a familiar address for every link.'
				: 'Your addresses, ready to share.'
	);

	const stateLabels: Record<Domain['state'], string> = {
		pending: 'Waiting for DNS',
		verifying: 'Verifying',
		active: 'Active',
		failed: 'Failed',
		disabled: 'Removed'
	};
	const stateTones: Record<Domain['state'], StatusTone> = {
		pending: 'warning',
		verifying: 'warning',
		active: 'live',
		failed: 'danger',
		disabled: 'neutral'
	};

	function stateLabel(domain: Domain): string {
		if (domain.kind === 'platform') return 'Ready';
		return domain.state === 'pending' && domain.setup === 'worker_custom_domain'
			? 'Waiting for setup'
			: stateLabels[domain.state];
	}

	function begin(action: string) {
		pending = action;
		error = '';
		status = '';
	}

	async function openAdd() {
		setupChoice = null;
		adding = true;
		await tick();
		hostnameInput?.focus();
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
			setupChoice = result.value.state === 'active' ? null : result.value.id;
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
			lastChecks = { ...lastChecks, [domain.id]: { at: Date.now(), state: result.value.state } };
			await onChanged();
			if (result.value.state === 'active') {
				setupChoice = null;
				selectedId = domain.id;
			}
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
			setupChoice = null;
			selectedId = null;
			status = `Removed ${domain.hostname}.`;
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

	function open(domain: Domain) {
		confirmingId = null;
		if (unfinished(domain)) {
			setupChoice = domain.id;
			return;
		}
		if (ready(domain)) selectedId = selectedId === domain.id ? null : domain.id;
	}

	function askRemove(domain: Domain) {
		if (unfinished(domain)) setupChoice = domain.id;
		else selectedId = domain.id;
		confirmingId = domain.id;
	}

	function actions(domain: Domain): MenuItem[] {
		const items: MenuItem[] = [];
		if (unfinished(domain))
			items.push({ label: 'Finish setup', icon: 'arrow', onselect: () => open(domain) });
		else if (ready(domain))
			items.push({ label: 'Show details', icon: 'info', onselect: () => (selectedId = domain.id) });
		if (linksHref && ready(domain))
			items.push({ label: 'View links', icon: 'link', href: linksHref(domain) });
		if (domain.kind === 'workspace' && domain.state !== 'disabled')
			items.push({
				label: 'Remove domain',
				icon: 'trash',
				danger: true,
				onselect: () => askRemove(domain)
			});
		return items;
	}
</script>

{#snippet usage()}
	<span class="usage" class:warn={atLimit || nearLimit}>
		{#if page.limit === 0}Custom domains are not available in this workspace.{:else}{numbers.format(
				page.used
			)} of {numbers.format(page.limit)} custom domains used{/if}
	</span>
{/snippet}

{#snippet readyBar()}
	{#if readyHost}
		<div class="ready-bar">
			<Glyph name="globe" size={22} />
			<p><strong>{readyHost}</strong> is ready to use while you finish setup.</p>
			{#if createHref}<a class="text-action" href={createHref}
					>Create a link<Glyph name="arrow" size={16} /></a
				>{/if}
		</div>
	{/if}
{/snippet}

<!-- The panel is passed only while a domain is open, so the list keeps the full width. -->
{#snippet details()}
	{#if selected}
		{@const domain = selected}
		<SidePanel id="domain-details-label" label="Domain details" onclose={() => (selectedId = null)}>
			<DomainDetails
				{domain}
				{createHref}
				linksHref={linksHref?.(domain)}
				confirming={confirmingId === domain.id}
				removing={pending === `remove:${domain.id}`}
				busy={pending !== null}
				stopping={stopping(domain.activeLinks)}
				onremove={() => (confirmingId = domain.id)}
				onconfirm={() => void remove(domain)}
				oncancel={() => (confirmingId = null)}
			/>
		</SidePanel>
	{/if}
{/snippet}

<SplitView panel={selected ? details : undefined}>
	<PageHeader {crumbs} title="Domains" {lead}>
		{#snippet aside()}
			{#if !empty && !setupDomain}
				<div class="aside">
					{@render usage()}
					{#if !adding && page.limit > 0}
						<Button
							variant="primary"
							icon="plus"
							disabled={atLimit || pending !== null}
							onclick={() => void openAdd()}>Add domain</Button
						>
					{/if}
				</div>
			{:else}
				{@render usage()}
			{/if}
		{/snippet}
	</PageHeader>

	<div class="domains" aria-busy={pending !== null}>
		<p class="visually-hidden" role="status" aria-live="polite">{status}</p>
		{#if error}<Callout tone="danger" role="alert"><p>{error}</p></Callout>{/if}

		{#if setupDomain}
			{@const domain = setupDomain}
			<button type="button" class="back" onclick={() => (setupChoice = null)}
				><Glyph name="arrowLeft" size={18} />All domains</button
			>
			<DomainSetup
				{domain}
				lastCheck={lastChecks[domain.id] ?? null}
				checking={pending === `check:${domain.id}`}
				wait={secondsLeft(domain.id)}
				busy={pending !== null}
				{guideHref}
				oncheck={() => void check(domain)}
				onremove={() => (confirmingId = domain.id)}
			/>
			{#if confirmingId === domain.id}
				<div class="confirm" role="alertdialog" aria-labelledby="confirm-{domain.id}">
					<p id="confirm-{domain.id}">
						<strong>Remove {domain.hostname}?</strong>
						{stopping(domain.activeLinks)}
					</p>
					<div class="confirm-actions">
						<Button size="sm" disabled={pending !== null} onclick={() => (confirmingId = null)}
							>Keep</Button
						>
						<Button
							size="sm"
							variant="danger"
							disabled={pending !== null}
							onclick={() => void remove(domain)}
							>{pending === `remove:${domain.id}` ? 'Removing…' : 'Remove'}</Button
						>
					</div>
				</div>
			{/if}
			{@render readyBar()}
		{:else if empty}
			<section class="hero" aria-labelledby="domain-hero-heading">
				<span class="hero-mark" aria-hidden="true"
					><Glyph name="globe" size={64} /><span class="badge-link"
						><Glyph name="link" size={16} /></span
					></span
				>
				<h2 id="domain-hero-heading">Your links. Your domain.</h2>
				{#if page.limit > 0}
					<p class="hero-lead">Add a subdomain you own, such as go.yourbrand.com.</p>
					<DomainAddForm
						bind:hostname
						bind:input={hostnameInput}
						error={fieldError}
						pending={pending === 'add'}
						disabled={atLimit || pending !== null}
						onsubmit={() => void add()}
						centered
					/>
					{#if guideHref}<a class="guide" href={guideHref}
							>How setup works<Glyph name="arrowUpRight" size={16} /></a
						>{/if}
				{:else}
					<p class="hero-lead">Custom domains are not available in this workspace.</p>
				{/if}
			</section>
			{#if platformDomains.length > 0}
				<section class="available" aria-labelledby="available-heading">
					<h2 id="available-heading" class="small-heading">Already available</h2>
					<ul>
						{#each platformDomains as domain (domain.id)}
							<li>
								<Glyph name="link" size={26} />
								<div class="available-main">
									<p class="available-name">
										<strong>{domain.hostname}</strong><Badge outlined>Included</Badge><StatusDot
											>Ready to use</StatusDot
										>
									</p>
									<p class="sub">Create links now. No domain setup needed.</p>
								</div>
								{#if createHref}<a class="text-action" href={createHref}
										>Create a link<Glyph name="arrow" size={16} /></a
									>{/if}
							</li>
						{/each}
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
			{#if adding && !atLimit}
				<section class="add-card" aria-labelledby="domain-add-heading">
					<h2 id="domain-add-heading" class="small-heading">Add a custom domain</h2>
					<DomainAddForm
						bind:hostname
						bind:input={hostnameInput}
						error={fieldError}
						pending={pending === 'add'}
						disabled={pending !== null}
						onsubmit={() => void add()}
						oncancel={() => {
							adding = false;
							fieldError = '';
						}}
					/>
				</section>
			{/if}
			<div class="table">
				<div class="columns" aria-hidden="true">
					<span>Domain</span><span>Status</span><span>Links</span><span></span>
				</div>
				<ul aria-label="Domains">
					{#each [...workspaceDomains, ...platformDomains] as domain (domain.id)}
						<!-- The name button is the keyboard path; the row click is a larger target. -->
						<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
						<li
							class="row"
							class:selected={selected?.id === domain.id}
							onclick={(event) => {
								if (!(event.target as HTMLElement).closest('a, button, [popover]')) open(domain);
							}}
						>
							<span class="cell name">
								<Glyph name={domain.kind === 'platform' ? 'link' : 'globe'} size={22} />
								<button
									type="button"
									class="hostname"
									aria-expanded={ready(domain) ? selected?.id === domain.id : undefined}
									onclick={() => open(domain)}>{domain.hostname}</button
								>
								{#if domain.isDefault}<Badge>Default</Badge>{/if}
								{#if domain.kind === 'platform'}<span class="included-badge"
										><Badge>Included</Badge></span
									>{/if}
							</span>
							<span class="cell">
								<StatusDot tone={domain.kind === 'platform' ? 'live' : stateTones[domain.state]}
									>{stateLabel(domain)}</StatusDot
								>
							</span>
							<span class="cell count"
								>{domain.activeLinks === null ? '–' : numbers.format(domain.activeLinks)}</span
							>
							<span class="cell">
								{#if actions(domain).length > 0}
									<Menu
										id="domain-menu-{domain.id}"
										label="More actions for {domain.hostname}"
										items={actions(domain)}
									/>
								{/if}
							</span>
						</li>
					{/each}
				</ul>
			</div>
			<div class="foot">
				<p>The default domain is preselected when you create a link.</p>
				{#if createHref}<a class="text-action" href={createHref}
						>View all links<Glyph name="arrow" size={16} /></a
					>{/if}
			</div>
			{#if atLimit && page.limit > 0}
				<p class="note">You have used all your custom domains. To add another, remove one first.</p>
			{:else if nearLimit}
				<p class="note">You are close to your custom domain limit.</p>
			{/if}
		{/if}
	</div>
</SplitView>

<style>
	.domains {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 1.5rem;
	}
	.aside {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 1rem 1.5rem;
	}
	.usage {
		color: var(--color-lead);
		font-size: 0.9375rem;
	}
	.usage.warn {
		color: var(--color-warning);
	}
	.back {
		display: inline-flex;
		align-items: center;
		justify-self: start;
		gap: 0.5rem;
		margin-top: -0.75rem;
		padding: 0.25rem 0;
		border: 0;
		background: none;
		color: var(--color-link);
		font: inherit;
		font-size: 0.9375rem;
		cursor: pointer;
	}
	.back:hover,
	.text-action:hover {
		text-decoration: underline;
		text-underline-offset: 3px;
	}
	.hero {
		display: grid;
		justify-items: center;
		gap: 0.85rem;
		padding: 0.5rem 0 1rem;
		text-align: center;
	}
	.hero-mark {
		position: relative;
		color: var(--color-strong);
	}
	.badge-link {
		position: absolute;
		right: -0.35rem;
		bottom: -0.1rem;
		display: grid;
		place-items: center;
		width: 1.85rem;
		height: 1.85rem;
		border: 2px solid var(--color-paper);
		border-radius: 50%;
		background: var(--color-accent);
		color: #fff;
	}
	.hero h2 {
		color: var(--color-strong);
		font-size: clamp(1.75rem, 2.6vw, 2.25rem);
		font-weight: 800;
		letter-spacing: -0.045em;
	}
	.hero-lead {
		margin-bottom: 0.5rem;
		color: var(--color-ink);
		font-size: 1.0625rem;
	}
	.guide {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		color: var(--color-link);
		font-size: 0.9375rem;
		text-decoration: underline;
		text-underline-offset: 3px;
	}
	.small-heading {
		color: var(--color-lead);
		font-size: 0.9375rem;
		font-weight: 500;
		letter-spacing: 0;
	}
	.available {
		display: grid;
		gap: 0.75rem;
		padding-top: 1.5rem;
		border-top: 1px solid var(--color-rule);
	}
	.available ul {
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.available li {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		align-items: center;
		gap: 1rem;
		padding: 0.75rem 0;
		border-bottom: 1px solid var(--color-rule);
		color: var(--color-strong);
	}
	.available-main {
		display: grid;
		gap: 0.2rem;
		min-width: 0;
	}
	.available-name {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem 1rem;
		color: var(--color-strong);
		font-size: 1.0625rem;
	}
	.sub,
	.note,
	.foot p {
		color: var(--color-lead);
		font-size: 0.875rem;
	}
	.included {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		color: var(--color-ink);
		font-size: 0.9375rem;
	}
	.text-action {
		display: inline-flex;
		flex: none;
		align-items: center;
		gap: 0.4rem;
		color: var(--color-link);
		font-size: 0.9375rem;
	}
	.add-card {
		display: grid;
		gap: 0.75rem;
		padding: 1.25rem 1.5rem;
		border: 1px solid var(--color-rule);
		border-radius: var(--radius-md, 0.625rem);
		background: var(--color-paper);
	}
	.table {
		border: 1px solid var(--color-rule);
		border-radius: var(--radius-md, 0.625rem);
		background: var(--color-paper);
		overflow: hidden;
		container-type: inline-size;
	}
	.columns,
	.row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 10rem 5rem 3rem;
		align-items: center;
	}
	.columns {
		min-height: 2.75rem;
		background: var(--color-canvas);
		border-bottom: 1px solid var(--color-rule);
		color: var(--color-lead);
		font-size: 0.75rem;
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}
	.columns > span {
		padding: 0 1rem;
	}
	.columns > span + span:not(:last-child) {
		align-self: stretch;
		display: flex;
		align-items: center;
		border-left: 1px solid var(--color-rule);
	}
	.row {
		position: relative;
		min-height: 3.6rem;
		cursor: pointer;
	}
	.table ul {
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.row + .row {
		border-top: 1px solid var(--color-rule);
	}
	.row:hover {
		background: var(--color-hover);
	}
	.row.selected {
		background: var(--color-accent-soft);
	}
	.row.selected::before {
		content: '';
		position: absolute;
		top: 0;
		bottom: 0;
		left: 0;
		width: 3px;
		background: var(--color-accent);
	}
	.cell {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		min-width: 0;
		align-self: stretch;
		padding: 0 1rem;
		color: var(--color-strong);
	}
	.cell + .cell:not(:last-child) {
		border-left: 1px solid var(--color-rule);
	}
	.name {
		padding-left: 1.25rem;
	}
	.hostname {
		overflow: hidden;
		padding: 0;
		border: 0;
		background: none;
		color: var(--color-strong);
		font: inherit;
		font-size: 1rem;
		text-overflow: ellipsis;
		white-space: nowrap;
		cursor: pointer;
	}
	.hostname:hover {
		text-decoration: underline;
		text-underline-offset: 3px;
	}
	.count {
		font-variant-numeric: tabular-nums;
	}
	.foot {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem 1rem;
		margin-top: -0.75rem;
	}
	.confirm {
		display: grid;
		gap: 0.75rem;
		width: min(100%, 40rem);
		margin-inline: auto;
		padding: 0.9rem 1rem;
		border: 1px solid color-mix(in oklch, var(--color-danger) 30%, transparent);
		border-radius: var(--radius-md, 0.625rem);
		background: var(--color-danger-soft);
		font-size: 0.9375rem;
	}
	.confirm p {
		color: var(--color-ink);
	}
	.confirm-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
	}
	.ready-bar {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		align-items: center;
		gap: 1rem;
		padding-top: 1.25rem;
		border-top: 1px solid var(--color-rule);
		color: var(--color-strong);
	}
	.ready-bar p {
		color: var(--color-ink);
		font-size: 0.9375rem;
	}
	.ready-bar strong {
		color: var(--color-strong);
	}
	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
	@container (max-width: 34rem) {
		.columns {
			display: none;
		}
		.row {
			grid-template-columns: minmax(0, 1fr) auto 2.75rem;
			padding: 0.5rem 0;
		}
		.cell + .cell:not(:last-child) {
			border-left: 0;
		}
		.included-badge {
			display: none;
		}
		.count {
			display: none;
		}
		.cell {
			padding: 0 0.5rem;
		}
		.name {
			gap: 0.6rem;
			padding-left: 1rem;
		}
	}
</style>
