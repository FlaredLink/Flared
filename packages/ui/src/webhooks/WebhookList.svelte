<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import type {
		CreateWebhookInput,
		WebhookDelivery,
		WebhookEndpoint,
		WebhookEndpointPage
	} from '@flared/contracts/webhooks';
	import {
		createWebhook,
		deleteWebhook,
		deliveryReason,
		endpointLabel,
		listWebhookDeliveries,
		rotateWebhookSecret,
		sendWebhookTest,
		updateWebhook,
		webhookChanges,
		webhookErrorMessage,
		type WebhookFailure
	} from './client';
	import WebhookForm, { eventLabels } from './WebhookForm.svelte';
	import WebhookDeliveries, {
		deliveryStates,
		type DeliveriesView
	} from './WebhookDeliveries.svelte';
	import { shownWorkspace } from '../workspace/shown';
	import Glyph from '../icons/Glyph.svelte';
	import Badge from '../atoms/Badge.svelte';
	import Button from '../atoms/Button.svelte';
	import SectionHeader from '../molecules/SectionHeader.svelte';
	import SidePanel from '../molecules/SidePanel.svelte';
	import SplitView from '../molecules/SplitView.svelte';
	import Callout from '../molecules/Callout.svelte';
	import CopyButton from '../molecules/CopyButton.svelte';

	interface Props {
		// The endpoints, the count against the limit, and the events, from the page's server load.
		page: WebhookEndpointPage;
		// The path of the /v1 API for this browser, such as "/api/v1".
		apiBase: string;
		// Only the owner adds and changes endpoints; anyone else sees a read-only notice.
		canManage: boolean;
		// Called when adding an endpoint or a new secret needs a recent sign-in. The edition asks
		// for its own proof.
		onReauthRequired?: () => void;
		// What the edition says when the workspace may keep no endpoints, such as a plan to choose.
		limitNotice?: Snippet;
	}
	let { page, apiBase, canManage, onReauthRequired, limitNotice }: Props = $props();
	const workspace = shownWorkspace();

	// The server load gives the first list; each change replaces it with the server's answer. A
	// new load from the page resets both.
	let endpoints = $derived(page.endpoints);
	let used = $derived(page.used);

	// "create", or "<action>:<endpoint id>" while a request runs.
	let pending = $state<string | null>(null);
	let status = $state('');
	let error = $state('');
	let errorField = $state<string | null>(null);
	// The side panel adds an endpoint or edits one.
	let panel = $state<{ mode: 'add' } | { mode: 'edit'; id: string } | null>(null);
	const editing = $derived.by(() => {
		const open = panel;
		return open?.mode === 'edit' ? endpoints.find((item) => item.id === open.id) : undefined;
	});
	// "rotate:<id>" or "delete:<id>" while the person confirms.
	let confirming = $state<string | null>(null);
	// A secret the server returned once, shown until the person closes it.
	let revealed = $state<{ endpoint: WebhookEndpoint; secret: string; rotated: boolean } | null>(
		null
	);
	let deliveries = $state<Record<string, DeliveriesView>>({});
	let tests = $state<Record<string, WebhookDelivery>>({});

	const times = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
	const numbers = new Intl.NumberFormat();
	const full = $derived(used >= page.limit);
	const later = (at: string | null) => at !== null && Date.parse(at) > Date.now();

	function begin(action: string) {
		pending = action;
		status = '';
		error = '';
		errorField = null;
	}

	function fail(failure: WebhookFailure) {
		if (failure.code === 'REAUTH_REQUIRED') onReauthRequired?.();
		error = webhookErrorMessage(failure);
		errorField = failure.field;
	}

	function replace(endpoint: WebhookEndpoint) {
		endpoints = endpoints.map((item) => (item.id === endpoint.id ? endpoint : item));
	}

	async function create(input: CreateWebhookInput) {
		begin('create');
		const result = await createWebhook(apiBase, input, workspace());
		pending = null;
		if (!result.ok) return fail(result.failure);
		endpoints = [...endpoints, result.value.endpoint];
		used += 1;
		revealed = { ...result.value, rotated: false };
		panel = null;
	}

	async function edit(endpoint: WebhookEndpoint, input: CreateWebhookInput) {
		const changes = webhookChanges(endpoint, input);
		begin(`edit:${endpoint.id}`);
		if (Object.keys(changes).length === 0) {
			pending = null;
			error = 'Change the URL, the events, or the milestone interval.';
			return;
		}
		const result = await updateWebhook(apiBase, endpoint.id, changes, workspace());
		pending = null;
		if (!result.ok) return fail(result.failure);
		replace(result.value);
		panel = null;
		status = `Saved ${endpointLabel(result.value.url)}.`;
	}

	async function rotate(endpoint: WebhookEndpoint) {
		begin(`rotate:${endpoint.id}`);
		const result = await rotateWebhookSecret(apiBase, endpoint.id, workspace());
		pending = null;
		confirming = null;
		if (!result.ok) return fail(result.failure);
		replace(result.value.endpoint);
		revealed = { ...result.value, rotated: true };
		delete tests[endpoint.id];
	}

	async function setEnabled(endpoint: WebhookEndpoint, enabled: boolean) {
		begin(`enabled:${endpoint.id}`);
		const result = await updateWebhook(apiBase, endpoint.id, { enabled }, workspace());
		pending = null;
		if (!result.ok) return fail(result.failure);
		replace(result.value);
		status = enabled
			? `Turned on ${endpointLabel(endpoint.url)}.`
			: `Turned off ${endpointLabel(endpoint.url)}. Flared sends it nothing until you turn it on.`;
	}

	async function remove(endpoint: WebhookEndpoint) {
		begin(`delete:${endpoint.id}`);
		const result = await deleteWebhook(apiBase, endpoint.id, workspace());
		pending = null;
		confirming = null;
		// An endpoint that is already gone is the result the person asked for.
		if (!result.ok && result.failure.code !== 'NOT_FOUND') return fail(result.failure);
		endpoints = endpoints.filter((item) => item.id !== endpoint.id);
		used = Math.max(0, used - 1);
		delete deliveries[endpoint.id];
		delete tests[endpoint.id];
		if (revealed?.endpoint.id === endpoint.id) revealed = null;
		if (panel?.mode === 'edit' && panel.id === endpoint.id) panel = null;
		status = `Deleted ${endpointLabel(endpoint.url)} and its delivery history.`;
	}

	async function test(endpoint: WebhookEndpoint) {
		begin(`test:${endpoint.id}`);
		const result = await sendWebhookTest(apiBase, endpoint.id, workspace());
		pending = null;
		if (!result.ok) return fail(result.failure);
		tests[endpoint.id] = result.value;
		const view = deliveries[endpoint.id];
		if (view?.state === 'ready')
			deliveries[endpoint.id] = {
				state: 'ready',
				deliveries: [
					result.value,
					...view.deliveries.filter((item) => item.id !== result.value.id)
				].slice(0, 50)
			};
	}

	async function loadDeliveries(id: string) {
		deliveries[id] = { state: 'loading' };
		const result = await listWebhookDeliveries(apiBase, id, workspace());
		// The person closed the list or deleted the endpoint while it loaded.
		if (deliveries[id]?.state !== 'loading') return;
		deliveries[id] = result.ok
			? { state: 'ready', deliveries: result.value }
			: { state: 'error', message: webhookErrorMessage(result.failure) };
	}

	function toggleDeliveries(id: string) {
		if (deliveries[id]) delete deliveries[id];
		else void loadDeliveries(id);
	}

	// One line about the test event the person sent last.
	function testSummary(delivery: WebhookDelivery): string {
		const state = deliveryStates[delivery.state].label;
		if (delivery.errorCode !== null)
			return `Test event: ${state}. ${deliveryReason(delivery.errorCode, delivery.responseStatus)}`;
		if (delivery.responseStatus !== null) {
			const took = delivery.durationMs === null ? '' : ` in ${delivery.durationMs} ms`;
			return `Test event: ${state}. The endpoint answered HTTP ${delivery.responseStatus}${took}.`;
		}
		return `Test event: ${state}.`;
	}

	function eventsText(endpoint: WebhookEndpoint): string {
		return endpoint.events
			.map((event) =>
				event === 'link.click_milestone' && endpoint.milestoneInterval !== null
					? `Every ${numbers.format(endpoint.milestoneInterval)} clicks`
					: eventLabels[event]
			)
			.join(', ');
	}
</script>

{#snippet formPanel()}
	{#if editing}
		{@const endpoint = editing}
		<SidePanel id="webhook-form-label" label="Webhook endpoint" onclose={() => (panel = null)}>
			{#key endpoint.id}
				<WebhookForm
					{endpoint}
					eventTypes={page.eventTypes}
					pending={pending === `edit:${endpoint.id}`}
					{error}
					{errorField}
					onsubmit={(input) => void edit(endpoint, input)}
					oncancel={() => (panel = null)}
				/>
			{/key}
		</SidePanel>
	{:else if panel?.mode === 'add'}
		<SidePanel id="webhook-form-label" label="New webhook endpoint" onclose={() => (panel = null)}>
			<WebhookForm
				eventTypes={page.eventTypes}
				pending={pending === 'create'}
				{error}
				{errorField}
				onsubmit={(input) => void create(input)}
				oncancel={() => (panel = null)}
			/>
		</SidePanel>
	{/if}
{/snippet}

<section class="webhooks" aria-labelledby="webhooks-heading">
	<SplitView panel={formPanel} open={editing !== undefined || panel?.mode === 'add'}>
		<div class="list">
			<SectionHeader
				id="webhooks-heading"
				title="Webhooks"
				lead="Flared sends a signed POST request to your endpoint when a link changes or reaches a click count."
			>
				{#snippet actions()}
					{#if canManage && page.limit > 0 && panel?.mode !== 'add'}
						<Button
							variant="primary"
							icon="plus"
							disabled={full || pending !== null}
							onclick={() => {
								panel = { mode: 'add' };
								revealed = null;
								error = '';
								errorField = null;
							}}>Add endpoint</Button
						>
					{/if}
				{/snippet}
			</SectionHeader>

			{#if page.limit === 0}
				<Callout tone="info" icon="plugs">
					{#if limitNotice}{@render limitNotice()}{:else}<p>
							Webhooks are off for this workspace.
						</p>{/if}
				</Callout>
			{:else}
				<p class="count">
					{used} of {page.limit}
					{page.limit === 1 ? 'endpoint' : 'endpoints'}{#if full && canManage}. Delete an endpoint
						before you add another.{/if}
				</p>
			{/if}
			{#if !canManage}
				<Callout tone="neutral" icon="lock">
					<p>Only the workspace owner can add or change webhook endpoints.</p>
				</Callout>
			{/if}

			<p class="status" role="status" aria-live="polite">{status}</p>
			{#if error && panel === null}<p class="error" role="alert">{error}</p>{/if}

			{#if revealed}
				<div class="reveal" role="region" aria-labelledby="webhook-secret-heading">
					<h3 id="webhook-secret-heading">
						Copy the {revealed.rotated ? 'new ' : ''}signing secret for {endpointLabel(
							revealed.endpoint.url
						)}
					</h3>
					<p>
						This secret will not be shown again. Store it where your endpoint can read it, and use
						it to check the webhook-signature header.
					</p>
					{#if revealed.rotated && revealed.endpoint.previousSecretUntil}
						<p>
							The old secret keeps working until
							<time datetime={revealed.endpoint.previousSecretUntil}
								>{times.format(new Date(revealed.endpoint.previousSecretUntil))}</time
							>.
						</p>
					{/if}
					<div class="secret">
						<label class="visually-hidden" for="webhook-secret">Signing secret</label>
						<input
							id="webhook-secret"
							readonly
							value={revealed.secret}
							spellcheck="false"
							onfocus={(event) => event.currentTarget.select()}
						/>
						<CopyButton
							text={revealed.secret}
							label="Copy secret"
							kind="button"
							variant="primary"
						/>
					</div>
					<Button variant="ghost" size="sm" onclick={() => (revealed = null)}>Done</Button>
				</div>
			{/if}

			{#if endpoints.length === 0}
				<p class="empty">
					{canManage && page.limit > 0
						? 'No endpoints yet. Add one to get link events in your own service.'
						: 'No endpoints.'}
				</p>
			{:else}
				<ul class="endpoints" aria-labelledby="webhooks-heading">
					{#each endpoints as endpoint (endpoint.id)}
						{@const label = endpointLabel(endpoint.url)}
						{@const busy = pending !== null}
						<li class="endpoint">
							<div class="top">
								<Glyph name="plugs" size={22} />
								<span class="name-text">
									<span class="name" title={label}>{label}</span>
									<span class="meta">{eventsText(endpoint)}</span>
								</span>
								<span class="badges">
									{#if !endpoint.enabled}
										<Badge tone="neutral" icon="pause">Off</Badge>
									{:else if later(endpoint.pausedUntil)}
										<Badge tone="warning" icon="hourglass">Paused</Badge>
									{:else}
										<Badge tone="positive">On</Badge>
									{/if}
								</span>
							</div>

							<dl class="facts">
								<div>
									<dt>Last success</dt>
									<dd>
										{#if endpoint.lastSuccessAt}<time datetime={endpoint.lastSuccessAt}
												>{times.format(new Date(endpoint.lastSuccessAt))}</time
											>{:else}Never{/if}
									</dd>
								</div>
								<div>
									<dt>Last failure</dt>
									<dd>
										{#if endpoint.lastFailureAt}<time datetime={endpoint.lastFailureAt}
												>{times.format(new Date(endpoint.lastFailureAt))}</time
											>{:else}None{/if}
									</dd>
								</div>
							</dl>

							{#if endpoint.enabled && endpoint.pausedUntil && later(endpoint.pausedUntil)}
								<p class="note">
									A delivery failed, so Flared waits until
									<time datetime={endpoint.pausedUntil}
										>{times.format(new Date(endpoint.pausedUntil))}</time
									>
									before it tries again.
								</p>
							{/if}
							{#if later(endpoint.previousSecretUntil)}
								<p class="note">
									The old secret also works until
									<time datetime={endpoint.previousSecretUntil}
										>{times.format(new Date(endpoint.previousSecretUntil ?? ''))}</time
									>.
								</p>
							{/if}
							{#if endpoint.secretChanged}
								<Callout tone="warning" icon="key">
									<p>Rotate the secret to continue.</p>
								</Callout>
							{/if}
							{#if tests[endpoint.id]}
								<p class="note test" role="status">{testSummary(tests[endpoint.id])}</p>
							{/if}

							<div class="actions">
								{#if canManage && confirming === `rotate:${endpoint.id}`}
									<span class="confirm"
										>Rotate the secret? The old secret keeps working for 24 hours.</span
									>
									<Button
										size="sm"
										variant="primary"
										disabled={busy}
										onclick={() => void rotate(endpoint)}
										>{pending === `rotate:${endpoint.id}` ? 'Rotating…' : 'Rotate'}</Button
									>
									<Button size="sm" variant="ghost" onclick={() => (confirming = null)}>Keep</Button
									>
								{:else if canManage && confirming === `delete:${endpoint.id}`}
									<span class="confirm"
										>Delete this endpoint? Its delivery history is removed too.</span
									>
									<Button
										size="sm"
										variant="danger"
										disabled={busy}
										onclick={() => void remove(endpoint)}
										>{pending === `delete:${endpoint.id}` ? 'Deleting…' : 'Delete'}</Button
									>
									<Button size="sm" variant="ghost" onclick={() => (confirming = null)}>Keep</Button
									>
								{:else}
									<Button
										size="sm"
										variant="ghost"
										icon={deliveries[endpoint.id] ? 'caretUp' : 'caretDown'}
										aria-expanded={deliveries[endpoint.id] !== undefined}
										aria-controls={`webhook-deliveries-${endpoint.id}`}
										onclick={() => toggleDeliveries(endpoint.id)}>Recent deliveries</Button
									>
									{#if canManage}
										<Button
											size="sm"
											disabled={busy}
											aria-label={`Edit ${label}`}
											onclick={() => {
												panel = { mode: 'edit', id: endpoint.id };
												error = '';
												errorField = null;
											}}>Edit</Button
										>
										{#if page.limit > 0}
											<Button
												size="sm"
												disabled={busy}
												aria-label={`Send a test event to ${label}`}
												onclick={() => void test(endpoint)}
												>{pending === `test:${endpoint.id}` ? 'Sending…' : 'Send test'}</Button
											>
										{/if}
										<Button
											size="sm"
											disabled={busy}
											aria-label={`${endpoint.enabled ? 'Turn off' : 'Turn on'} ${label}`}
											onclick={() => void setEnabled(endpoint, !endpoint.enabled)}
											>{pending === `enabled:${endpoint.id}`
												? 'Saving…'
												: endpoint.enabled
													? 'Turn off'
													: 'Turn on'}</Button
										>
										<Button
											size="sm"
											disabled={busy}
											aria-label={`Rotate the secret of ${label}`}
											onclick={() => (confirming = `rotate:${endpoint.id}`)}>Rotate secret…</Button
										>
										<Button
											size="sm"
											variant="danger-soft"
											disabled={busy}
											aria-label={`Delete ${label}`}
											onclick={() => (confirming = `delete:${endpoint.id}`)}>Delete…</Button
										>
									{/if}
								{/if}
							</div>

							{#if deliveries[endpoint.id]}
								<WebhookDeliveries
									id={`webhook-deliveries-${endpoint.id}`}
									view={deliveries[endpoint.id]}
									onretry={() => void loadDeliveries(endpoint.id)}
								/>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}

			<p class="foot">
				<Glyph name="lock" size={20} />Flared signs each request with the endpoint's secret. Check
				the signature before you trust a request.
			</p>
		</div>
	</SplitView>
</section>

<style>
	.list {
		display: grid;
		gap: 1rem;
		min-width: 0;
	}
	.count {
		color: var(--color-strong);
		font-size: 0.9875rem;
	}
	.status,
	.empty,
	.meta,
	.note {
		color: var(--color-lead);
		font-size: 0.875rem;
	}
	.status:empty {
		display: none;
	}
	.test {
		color: var(--color-ink);
	}
	.error {
		color: var(--color-danger);
		font-size: 0.875rem;
	}
	.reveal {
		display: grid;
		gap: 0.6rem;
		padding: 1rem 1.25rem;
		border: 1px solid color-mix(in oklch, var(--color-positive) 35%, transparent);
		border-radius: var(--radius-md, 0.625rem);
		background: var(--color-positive-soft);
	}
	.reveal h3 {
		overflow-wrap: anywhere;
		color: var(--color-strong);
		font-size: 1rem;
	}
	.reveal p {
		color: var(--color-ink);
		font-size: 0.9375rem;
	}
	.reveal > :global(button:last-child) {
		justify-self: start;
	}
	.secret {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}
	.secret input {
		flex: 1 1 16rem;
		min-width: 0;
		min-height: 2.75rem;
		padding: 0 0.9rem;
		border: 1px solid var(--color-rule);
		border-radius: var(--radius-control, 0.5rem);
		background: var(--color-paper);
		color: var(--color-strong);
		font-family: var(--font-mono);
		font-size: 0.875rem;
	}
	.endpoints {
		display: grid;
		gap: 0.75rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.endpoint {
		display: grid;
		gap: 0.75rem;
		padding: 1rem 1.1rem;
		border: 1px solid var(--color-rule);
		border-radius: var(--radius-md, 0.625rem);
		background: var(--color-paper);
	}
	.top {
		display: flex;
		align-items: center;
		gap: 0.85rem;
		min-width: 0;
		color: var(--color-ink);
	}
	.name-text {
		display: grid;
		flex: 1;
		gap: 0.1rem;
		min-width: 0;
	}
	.name {
		overflow: hidden;
		color: var(--color-strong);
		font-family: var(--font-mono);
		font-size: 0.9375rem;
		font-weight: 600;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.badges {
		display: flex;
		gap: 0.4rem;
	}
	.facts {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem 2rem;
		margin: 0;
		font-size: 0.875rem;
	}
	.facts div {
		display: flex;
		gap: 0.4rem;
	}
	dt {
		color: var(--color-lead);
	}
	dd {
		margin: 0;
		color: var(--color-ink);
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.4rem;
	}
	.confirm {
		color: var(--color-strong);
		font-size: 0.9375rem;
	}
	.foot {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		color: var(--color-lead);
		font-size: 0.875rem;
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
