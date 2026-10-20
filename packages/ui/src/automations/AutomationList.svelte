<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import type {
		Automation,
		AutomationPage,
		CreateAutomationInput
	} from '@flared/contracts/automations';
	import {
		automationChanges,
		automationErrorMessage,
		createAutomation,
		deleteAutomation,
		updateAutomation,
		type AutomationFailure
	} from './client';
	import {
		actionText,
		defaultMessageLabel,
		triggerText,
		type AutomationEndpoint,
		type AutomationMessageTarget
	} from './text';
	import AutomationForm from './AutomationForm.svelte';
	import AutomationRuns from './AutomationRuns.svelte';
	import { shownWorkspace } from '../workspace/shown';
	import Glyph from '../icons/Glyph.svelte';
	import Badge from '../atoms/Badge.svelte';
	import Button from '../atoms/Button.svelte';
	import Callout from '../molecules/Callout.svelte';
	import PageHeader from '../molecules/PageHeader.svelte';
	import SidePanel from '../molecules/SidePanel.svelte';
	import SplitView from '../molecules/SplitView.svelte';

	interface Props {
		// The templates, the count against the limit, and what the installation offers, from the
		// page's server load.
		page: AutomationPage;
		// The path of the /v1 API for this browser, such as "/api/v1".
		apiBase: string;
		// Only the owner creates and changes templates; anyone else sees a read-only notice.
		canManage: boolean;
		// The workspace's webhook endpoints, or null when the viewer cannot read them.
		endpoints: readonly AutomationEndpoint[] | null;
		// Where webhook endpoints are added and changed.
		webhooksHref?: string;
		// The places the post-message action can post to, or null when the page could not read
		// them; the edition's name for the action; and where the owner adds places.
		messageTargets?: readonly AutomationMessageTarget[] | null;
		messageLabel?: string;
		messageTargetsHref?: string;
		// What the edition says when the workspace may keep no automations, such as a plan to choose.
		limitNotice?: Snippet;
	}
	let {
		page,
		apiBase,
		canManage,
		endpoints,
		webhooksHref,
		messageTargets = null,
		messageLabel = defaultMessageLabel,
		messageTargetsHref,
		limitNotice
	}: Props = $props();
	const messages = $derived({ label: messageLabel, targets: messageTargets });
	const workspace = shownWorkspace();

	// The server load gives the first list; each change replaces it with the server's answer. A
	// new load from the page resets both.
	let automations = $derived(page.automations);
	let used = $derived(page.used);

	// "create", or "<action>:<automation id>" while a request runs.
	let pending = $state<string | null>(null);
	let status = $state('');
	let error = $state('');
	let errorField = $state<string | null>(null);
	// The side panel creates a template or edits one.
	let panel = $state<{ mode: 'add' } | { mode: 'edit'; id: string } | null>(null);
	const editing = $derived.by(() => {
		const open = panel;
		return open?.mode === 'edit' ? automations.find((item) => item.id === open.id) : undefined;
	});
	// The template whose deletion the person confirms.
	let confirming = $state<string | null>(null);
	// Templates whose run history is open.
	let runsOpen = $state<string[]>([]);

	const full = $derived(used >= page.limit);
	const numbers = new Intl.NumberFormat();

	// A send-webhook action whose endpoint is gone. Unknown while the endpoints are unknown.
	function lostEndpoint(automation: Automation): boolean {
		const list = endpoints;
		if (list === null) return false;
		return automation.actions.some(
			(action) =>
				action.type === 'send_webhook' && !list.some((item) => item.id === action.endpointId)
		);
	}

	// A post-message action whose target is gone. Unknown while the targets are unknown.
	function lostTarget(automation: Automation): boolean {
		const list = messageTargets;
		if (list === null) return false;
		return automation.actions.some(
			(action) =>
				action.type === 'post_message' && !list.some((item) => item.id === action.endpointId)
		);
	}

	function begin(action: string) {
		pending = action;
		status = '';
		error = '';
		errorField = null;
	}

	function fail(failure: AutomationFailure) {
		error = automationErrorMessage(failure);
		errorField = failure.field;
	}

	function replace(automation: Automation) {
		automations = automations.map((item) => (item.id === automation.id ? automation : item));
	}

	async function create(input: CreateAutomationInput) {
		begin('create');
		const result = await createAutomation(apiBase, input, workspace());
		pending = null;
		if (!result.ok) return fail(result.failure);
		automations = [...automations, result.value];
		used += 1;
		panel = null;
		status = `Created ${result.value.name}. Apply it to links from the Links page.`;
	}

	async function edit(automation: Automation, input: CreateAutomationInput) {
		const changes = automationChanges(automation, input);
		begin(`edit:${automation.id}`);
		if (Object.keys(changes).length === 0) {
			pending = null;
			error = 'Change the name, the trigger, or the actions.';
			return;
		}
		const result = await updateAutomation(apiBase, automation.id, changes, workspace());
		pending = null;
		if (!result.ok) return fail(result.failure);
		replace(result.value);
		panel = null;
		status = `Saved ${result.value.name}.`;
	}

	async function setEnabled(automation: Automation, enabled: boolean) {
		begin(`enabled:${automation.id}`);
		const result = await updateAutomation(apiBase, automation.id, { enabled }, workspace());
		pending = null;
		if (!result.ok) return fail(result.failure);
		replace(result.value);
		status = enabled
			? `Turned on ${automation.name}.`
			: `Turned off ${automation.name}. It does not run on any link until you turn it on.`;
	}

	async function remove(automation: Automation) {
		begin(`delete:${automation.id}`);
		const result = await deleteAutomation(apiBase, automation.id, workspace());
		pending = null;
		confirming = null;
		// A template that is already gone is the result the person asked for.
		if (!result.ok && result.failure.code !== 'NOT_FOUND') return fail(result.failure);
		automations = automations.filter((item) => item.id !== automation.id);
		used = Math.max(0, used - 1);
		runsOpen = runsOpen.filter((id) => id !== automation.id);
		if (panel?.mode === 'edit' && panel.id === automation.id) panel = null;
		status = `Deleted ${automation.name}. It is off every link, and its run history is gone.`;
	}

	function toggleRuns(id: string) {
		runsOpen = runsOpen.includes(id) ? runsOpen.filter((item) => item !== id) : [...runsOpen, id];
	}

	function openPanel(next: { mode: 'add' } | { mode: 'edit'; id: string }) {
		panel = next;
		error = '';
		errorField = null;
	}
</script>

{#snippet formPanel()}
	{#if editing}
		{@const automation = editing}
		<SidePanel id="automation-form-label" label="Automation" onclose={() => (panel = null)}>
			{#key automation.id}
				<AutomationForm
					initial={automation}
					{endpoints}
					actionTypes={page.actionTypes}
					triggerTypes={page.triggerTypes}
					{webhooksHref}
					{messageTargets}
					{messageLabel}
					{messageTargetsHref}
					pending={pending === `edit:${automation.id}`}
					{error}
					{errorField}
					onsubmit={(input) => void edit(automation, input)}
					oncancel={() => (panel = null)}
				/>
			{/key}
		</SidePanel>
	{:else if panel?.mode === 'add'}
		<SidePanel id="automation-form-label" label="New automation" onclose={() => (panel = null)}>
			<AutomationForm
				{endpoints}
				actionTypes={page.actionTypes}
				triggerTypes={page.triggerTypes}
				{webhooksHref}
				{messageTargets}
				{messageLabel}
				{messageTargetsHref}
				pending={pending === 'create'}
				{error}
				{errorField}
				onsubmit={(input) => void create(input)}
				oncancel={() => (panel = null)}
			/>
		</SidePanel>
	{/if}
{/snippet}

<PageHeader title="Automations" lead="Templates you apply to links from the Links page.">
	{#snippet aside()}
		{#if canManage && page.limit > 0}
			<Button
				size="sm"
				variant="primary"
				icon="plus"
				disabled={full || pending !== null || panel?.mode === 'add'}
				onclick={() => openPanel({ mode: 'add' })}
				>New<span class="wide-label">&nbsp;automation</span></Button
			>
		{/if}
	{/snippet}
</PageHeader>

<div class="automations">
	<SplitView panel={formPanel} open={editing !== undefined || panel?.mode === 'add'}>
		<div class="list">
			{#if page.limit === 0}
				<Callout tone="info" icon="lightning">
					{#if limitNotice}{@render limitNotice()}{:else}<p>
							Automations are off for this workspace.
						</p>{/if}
				</Callout>
			{:else}
				<p class="count">
					{numbers.format(used)} of {numbers.format(page.limit)}
					{page.limit === 1 ? 'automation' : 'automations'}{#if full && canManage}. Delete an
						automation before you add another.{/if}
				</p>
			{/if}
			{#if !canManage}
				<Callout tone="neutral" icon="lock">
					<p>
						Only the workspace owner can create or change automations. You can apply them to links
						from the Links page.
					</p>
				</Callout>
			{/if}

			<p class="status" role="status" aria-live="polite">{status}</p>
			{#if error && panel === null}<p class="error" role="alert">{error}</p>{/if}

			{#if automations.length === 0}
				<p class="empty">
					{canManage && page.limit > 0
						? 'No automations yet. Create one, then apply it to links from the Links page.'
						: 'No automations.'}
				</p>
			{:else}
				<ul class="templates" aria-label="Automation templates">
					{#each automations as automation (automation.id)}
						{@const busy = pending !== null}
						{@const runsId = `automation-runs-${automation.id}`}
						<li class="template" class:off={!automation.enabled}>
							<div class="top">
								<span class="name">{automation.name}</span>
								<span class="applied"
									>On {numbers.format(automation.links)}
									{automation.links === 1 ? 'link' : 'links'}</span
								>
								{#if canManage}
									<button
										type="button"
										role="switch"
										class="switch"
										aria-checked={automation.enabled}
										aria-label="Turn {automation.name} on or off"
										disabled={busy}
										onclick={() => void setEnabled(automation, !automation.enabled)}
										><span></span></button
									>
								{:else if !automation.enabled}
									<Badge tone="neutral" icon="pause">Off</Badge>
								{/if}
							</div>

							<!-- The steps read as one sentence: when, then each action in its order. -->
							<p class="flow">
								<span class="step"><b>When</b>{triggerText(automation.trigger)}</span>
								<span class="arrow"><Glyph name="arrow" size={14} /></span>
								{#each automation.actions as action (action.type)}
									<span class="step"><b>Then</b>{actionText(action, endpoints, messages)}</span>
								{/each}
							</p>

							{#if lostEndpoint(automation)}
								<Callout tone="warning" icon="plugs">
									<p>
										The webhook endpoint of this automation was deleted. Runs record a failure until
										you choose another endpoint.
									</p>
								</Callout>
							{/if}
							{#if lostTarget(automation)}
								<Callout tone="warning" icon="plugs">
									<p>
										The place this automation posts to was removed. Runs record a failure until you
										choose another place.
									</p>
								</Callout>
							{/if}

							<div class="actions">
								{#if canManage && confirming === automation.id}
									<span class="confirm"
										>Delete this automation? It comes off every link, and its run history is removed
										too.</span
									>
									<Button
										size="sm"
										variant="danger"
										disabled={busy}
										onclick={() => void remove(automation)}
										>{pending === `delete:${automation.id}` ? 'Deleting…' : 'Delete'}</Button
									>
									<Button size="sm" variant="ghost" onclick={() => (confirming = null)}>Keep</Button
									>
								{:else}
									<Button
										size="sm"
										variant="ghost"
										icon={runsOpen.includes(automation.id) ? 'caretUp' : 'caretDown'}
										aria-expanded={runsOpen.includes(automation.id)}
										aria-controls={runsId}
										onclick={() => toggleRuns(automation.id)}>Recent runs</Button
									>
									{#if canManage}
										<Button
											size="sm"
											disabled={busy}
											aria-label="Edit {automation.name}"
											onclick={() => openPanel({ mode: 'edit', id: automation.id })}>Edit</Button
										>
										<Button
											size="sm"
											variant="danger-soft"
											disabled={busy}
											aria-label="Delete {automation.name}"
											onclick={() => (confirming = automation.id)}>Delete…</Button
										>
									{/if}
								{/if}
							</div>

							{#if runsOpen.includes(automation.id)}
								<AutomationRuns id={runsId} automationId={automation.id} {apiBase} />
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	</SplitView>
</div>

<style>
	.list {
		display: grid;
		gap: 0.75rem;
		min-width: 0;
	}
	.count,
	.status,
	.empty {
		color: var(--color-subtle);
		font-size: 0.875rem;
	}
	.status:empty {
		display: none;
	}
	.error {
		color: var(--color-danger);
		font-size: 0.875rem;
	}
	.wide-label {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
	.templates {
		display: grid;
		gap: 0.625rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.template {
		display: grid;
		gap: 0.75rem;
		padding: 0.875rem 1rem;
		border-radius: 0.75rem;
		background: var(--color-surface);
		box-shadow: var(--shadow-ring);
		transition: opacity var(--dur-fast, 140ms) var(--ease-out, ease);
	}
	/* An off template dims as a whole. Pointing at it or moving focus into it brings it back to
	   full strength, so its switch and buttons read as usable while the person uses them. */
	.off:not(:hover, :focus-within) {
		opacity: 0.55;
	}
	.top {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		min-width: 0;
	}
	.name {
		flex: 1;
		min-width: 0;
		overflow-wrap: anywhere;
		color: var(--color-strong);
		font-size: 0.9375rem;
		font-weight: 600;
	}
	.applied {
		flex: none;
		color: var(--color-subtle);
		font-size: 0.8125rem;
	}
	.switch {
		position: relative;
		flex: none;
		width: 2.5rem;
		height: 1.5rem;
		padding: 0;
		border: 0;
		border-radius: var(--radius-pill, 999px);
		/* The off track keeps 3:1 against the card, so the control stays visible. */
		background: color-mix(in oklch, var(--color-muted) 75%, var(--color-paper));
		cursor: pointer;
		transition: background var(--dur-fast, 140ms) var(--ease-out, ease);
	}
	.switch span {
		position: absolute;
		top: 0.1875rem;
		left: 0.1875rem;
		width: 1.125rem;
		height: 1.125rem;
		border-radius: 50%;
		background: #fff;
		box-shadow: 0 1px 2px rgb(10 10 10 / 0.25);
		transition: transform var(--dur-fast, 140ms) var(--ease-out, ease);
	}
	.switch[aria-checked='true'] {
		background: var(--color-positive);
	}
	.switch[aria-checked='true'] span {
		transform: translateX(1rem);
	}
	.switch:focus-visible {
		outline: 2px solid var(--color-focus);
		outline-offset: 2px;
	}
	.switch:disabled {
		cursor: progress;
	}
	/* Phone: one step per line, the label in a fixed column. From 48rem the steps run in a row
	   with an arrow after the trigger. */
	.flow {
		display: grid;
		gap: 0.375rem;
		margin: 0;
	}
	.step {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		min-width: 0;
		padding: 0.5rem 0.625rem;
		border-radius: 0.5625rem;
		background: var(--color-surface-2);
		color: var(--color-ink);
		font-size: 0.875rem;
		overflow-wrap: anywhere;
	}
	.step b {
		flex: none;
		width: 2.5rem;
		color: var(--color-subtle);
		font-weight: 400;
	}
	.arrow {
		display: none;
		flex: none;
		color: var(--color-faint);
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
	@media (min-width: 48rem) {
		.wide-label {
			position: static;
			width: auto;
			height: auto;
			overflow: visible;
			clip-path: none;
		}
		.flow {
			display: flex;
			flex-wrap: wrap;
			align-items: center;
			gap: 0.5rem;
		}
		.step {
			display: inline-flex;
			gap: 0.375rem;
			padding: 0.375rem 0.625rem;
			font-size: 0.8125rem;
		}
		.step b {
			width: auto;
			font-size: 0.6875rem;
			font-weight: 600;
			letter-spacing: 0.04em;
			text-transform: uppercase;
		}
		.arrow {
			display: inline-flex;
		}
	}
</style>
