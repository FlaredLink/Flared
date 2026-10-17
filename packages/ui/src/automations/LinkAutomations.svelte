<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts" module>
	import type { LinkAutomationState } from '@flared/contracts/automations';
	import type { BadgeTone } from '../atoms/Badge.svelte';

	const linkStates: Record<LinkAutomationState, { label: string; tone: BadgeTone }> = {
		waiting: { label: 'Waiting', tone: 'neutral' },
		done: { label: 'Ran', tone: 'positive' },
		failed: { label: 'Failed', tone: 'danger' },
		skipped: { label: 'Skipped', tone: 'warning' }
	};
</script>

<script lang="ts">
	import {
		automationsPerLink,
		type Automation,
		type LinkAutomation
	} from '@flared/contracts/automations';
	import {
		applyAutomation,
		automationErrorMessage,
		isoToLocalDateTime,
		listLinkAutomations,
		localDateTimeToIso,
		removeLinkAutomation
	} from './client';
	import { resultText, triggerText } from './text';
	import { shownWorkspace } from '../workspace/shown';
	import Glyph from '../icons/Glyph.svelte';
	import Badge from '../atoms/Badge.svelte';
	import Button from '../atoms/Button.svelte';
	import Select from '../atoms/Select.svelte';
	import TextInput from '../atoms/TextInput.svelte';
	import Callout from '../molecules/Callout.svelte';
	import FormField from '../molecules/FormField.svelte';

	interface Props {
		linkId: string;
		// The path of the /v1 API for this browser, such as "/api/v1".
		apiBase: string;
		// The workspace's templates; only the ones that are on can be applied.
		automations: readonly Automation[];
		// Whether the viewer may apply and remove automations on links.
		canApply: boolean;
		// Where templates are created and turned on.
		automationsHref?: string;
		// 4 inside the link details panel, under its h3; 2 as a section of a link page.
		headingLevel?: 2 | 4;
	}
	let {
		linkId,
		apiBase,
		automations,
		canApply,
		automationsHref,
		headingLevel = 4
	}: Props = $props();
	const workspace = shownWorkspace();
	const times = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
	const numbers = new Intl.NumberFormat();

	type View =
		| { state: 'loading' }
		| { state: 'error'; message: string }
		| { state: 'ready'; items: LinkAutomation[] };
	let view = $state<View>({ state: 'loading' });
	// Each load gets a number, so an answer for an earlier link is dropped.
	let request = 0;

	// "apply", or "remove:<automation id>" while a request runs.
	let pending = $state<string | null>(null);
	let status = $state('');
	let error = $state('');
	let formOpen = $state(false);
	let automationId = $state('');
	let endsAt = $state('');
	let endsError = $state<string | null>(null);

	const usable = $derived(automations.filter((item) => item.enabled));
	const chosen = $derived(usable.find((item) => item.id === automationId) ?? null);
	const needsDate = $derived(chosen?.trigger.type === 'end_date');
	const endsIso = $derived(localDateTimeToIso(endsAt));
	const past = $derived(endsIso !== null && Date.parse(endsIso) <= Date.now());
	const items = $derived(view.state === 'ready' ? view.items : []);

	async function load(link: string) {
		const current = ++request;
		view = { state: 'loading' };
		const result = await listLinkAutomations(apiBase, link, workspace());
		if (current !== request) return;
		view = result.ok
			? { state: 'ready', items: result.value }
			: { state: 'error', message: automationErrorMessage(result.failure) };
	}

	// A new link starts with a fresh list and a closed form.
	$effect(() => {
		const link = linkId;
		formOpen = false;
		status = '';
		error = '';
		void load(link);
	});

	const at = (iso: string) => times.format(new Date(iso));

	function detail(item: LinkAutomation): string {
		if (item.state !== 'waiting') {
			const when = item.firedAt ? at(item.firedAt) : null;
			if (item.state === 'done') return when ? `Ran ${when}.` : 'Ran.';
			const reason = item.result ? resultText(item.result) : '';
			return [when ? `${when}.` : '', reason].filter(Boolean).join(' ');
		}
		if (!item.enabled) return 'The automation is off, so it does not run on this link.';
		if (item.result === 'not_checkable') return resultText(item.result);
		if (item.dueAt && Date.parse(item.dueAt) <= Date.now()) return 'The trigger is met. Runs soon.';
		switch (item.trigger.type) {
			case 'end_date':
				return item.endsAt ? `Runs ${at(item.endsAt)}.` : 'Waits for an end date.';
			case 'link_age':
				return item.dueAt ? `Runs ${at(item.dueAt)}.` : `${triggerText(item.trigger)}.`;
			case 'clicks':
				return `Runs when the link passes ${numbers.format(item.trigger.clicks)} clicks.`;
			case 'destination_down': {
				const check = item.check;
				if (!check?.lastCheckedAt) return 'Flared has not checked the destination yet.';
				const failures =
					check.failures > 0
						? ` ${check.failures === 1 ? '1 failed check' : `${check.failures} failed checks`} in a row.`
						: '';
				const result = check.lastResult ? ` (${check.lastResult})` : '';
				return `Last checked ${at(check.lastCheckedAt)}${result}.${failures}`;
			}
		}
	}

	function openForm(id = '') {
		formOpen = true;
		error = '';
		endsError = null;
		choose(id);
	}

	// A template already on the link starts from its end date, so applying again keeps it.
	function choose(id: string) {
		automationId = id;
		const current = items.find((item) => item.automationId === id);
		endsAt = current?.endsAt ? isoToLocalDateTime(current.endsAt) : '';
	}

	async function apply(event: SubmitEvent) {
		event.preventDefault();
		error = '';
		endsError = null;
		if (!chosen) {
			error = 'Choose an automation.';
			return;
		}
		if (needsDate && endsIso === null) {
			endsError = 'Choose the date and time the automation runs.';
			return;
		}
		pending = 'apply';
		const link = linkId;
		const name = chosen.name;
		const result = await applyAutomation(
			apiBase,
			link,
			chosen.id,
			needsDate ? endsIso : null,
			workspace()
		);
		pending = null;
		if (link !== linkId) return;
		if (!result.ok) {
			if (result.failure.field === 'endsAt') endsError = automationErrorMessage(result.failure);
			else error = automationErrorMessage(result.failure);
			return;
		}
		formOpen = false;
		view = { state: 'ready', items: result.value };
		status = `Applied ${name}.`;
	}

	async function remove(item: LinkAutomation) {
		pending = `remove:${item.automationId}`;
		status = '';
		error = '';
		const link = linkId;
		const result = await removeLinkAutomation(apiBase, link, item.automationId, workspace());
		pending = null;
		if (link !== linkId) return;
		// One that is already gone is the result the person asked for.
		if (!result.ok && result.failure.code !== 'NOT_FOUND') {
			error = automationErrorMessage(result.failure);
			return;
		}
		if (view.state === 'ready')
			view = {
				state: 'ready',
				items: view.items.filter((entry) => entry.automationId !== item.automationId)
			};
		status = `Removed ${item.name} from this link.`;
	}
</script>

<div class="link-automations">
	<div class="row">
		<svelte:element this={`h${headingLevel}`} id="link-automations-heading" class="heading"
			>Automations</svelte:element
		>
		{#if canApply && !formOpen && view.state === 'ready'}
			<Button size="sm" icon="plus" disabled={pending !== null} onclick={() => openForm()}
				>Apply automation</Button
			>
		{/if}
	</div>

	{#if view.state === 'loading'}
		<p class="note" role="status">Loading automations…</p>
	{:else if view.state === 'error'}
		<div class="note">
			<p class="error" role="alert">{view.message}</p>
			<Button size="sm" onclick={() => void load(linkId)}>Try again</Button>
		</div>
	{:else}
		{#if items.length === 0 && !formOpen}
			<p class="note">No automations on this link.</p>
		{:else if items.length > 0}
			<ul class="items" aria-labelledby="link-automations-heading">
				{#each items as item (item.automationId)}
					{@const badge = linkStates[item.state]}
					<li>
						<div class="item-top">
							<span class="chip"><Glyph name="lightning" size={12} />{item.name}</span>
							<Badge tone={badge.tone}>{badge.label}</Badge>
						</div>
						<p class="detail">{detail(item)}</p>
						{#if canApply}
							<div class="item-actions">
								{#if item.state !== 'waiting' && item.enabled}
									<Button
										size="sm"
										variant="ghost"
										disabled={pending !== null}
										aria-label="Apply {item.name} again"
										onclick={() => openForm(item.automationId)}>Apply again</Button
									>
								{/if}
								<Button
									size="sm"
									variant="ghost"
									disabled={pending !== null}
									aria-label="Remove {item.name} from this link"
									onclick={() => void remove(item)}
									>{pending === `remove:${item.automationId}` ? 'Removing…' : 'Remove'}</Button
								>
							</div>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}

		{#if formOpen}
			{#if usable.length === 0}
				<div class="note">
					<p>
						No automation is on.
						{#if automationsHref}<a href={automationsHref}>Open Automations</a>{:else}The workspace
							owner creates automations and turns them on.{/if}
					</p>
					<Button size="sm" variant="ghost" onclick={() => (formOpen = false)}>Close</Button>
				</div>
			{:else}
				<form class="apply" onsubmit={apply} novalidate>
					<FormField for="link-automation-choice" label="Automation">
						<Select
							id="link-automation-choice"
							value={automationId}
							onchange={(event) => choose(event.currentTarget.value)}
						>
							<option value="" disabled>Choose an automation</option>
							{#each usable as automation (automation.id)}
								<option value={automation.id}>{automation.name}</option>
							{/each}
						</Select>
					</FormField>
					{#if chosen}<p class="note">When: {triggerText(chosen.trigger)}</p>{/if}
					{#if needsDate}
						<FormField
							for="link-automation-ends"
							label="End date and time"
							hint="In your time zone."
							error={endsError}
						>
							<TextInput
								id="link-automation-ends"
								type="datetime-local"
								bind:value={endsAt}
								required
								invalid={endsError !== null}
								aria-describedby={endsError
									? 'link-automation-ends-hint link-automation-ends-error'
									: 'link-automation-ends-hint'}
							/>
						</FormField>
						{#if past}
							<Callout tone="warning">
								<p>This time has passed, so the automation runs on this link soon.</p>
							</Callout>
						{/if}
					{/if}
					{#if items.length >= automationsPerLink && !items.some((item) => item.automationId === automationId)}
						<p class="note">
							A link keeps up to {automationsPerLink} automations. Remove one before you apply another.
						</p>
					{/if}
					<div class="form-buttons">
						<Button type="submit" size="sm" variant="primary" disabled={pending !== null}
							>{pending === 'apply' ? 'Applying…' : 'Apply'}</Button
						>
						<Button size="sm" variant="ghost" onclick={() => (formOpen = false)}>Cancel</Button>
					</div>
				</form>
			{/if}
		{/if}
	{/if}

	{#if error}<p class="error" role="alert">{error}</p>{/if}
	<p class="status" role="status" aria-live="polite">{status}</p>
</div>

<style>
	.link-automations {
		display: grid;
		gap: 0.6rem;
	}
	.row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
	}
	.heading {
		margin: 0;
		color: var(--color-strong);
		font-size: 1rem;
		font-weight: 600;
	}
	.note,
	.status {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.6rem;
		color: var(--color-lead);
		font-size: 0.875rem;
	}
	.note a {
		color: var(--color-link);
		text-decoration: underline;
	}
	.status:empty {
		display: none;
	}
	.error {
		color: var(--color-danger);
		font-size: 0.875rem;
	}
	.items {
		display: grid;
		gap: 0.5rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.items li {
		display: grid;
		gap: 0.3rem;
	}
	.items li + li {
		padding-top: 0.5rem;
		border-top: 1px solid var(--color-rule);
	}
	.item-top {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
	}
	.chip {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		min-width: 0;
		padding: 0.2rem 0.55rem;
		border: 1px solid var(--color-rule);
		border-radius: var(--radius-pill, 999px);
		background: var(--color-selected);
		color: var(--color-ink);
		font-size: 0.8125rem;
		overflow-wrap: anywhere;
	}
	.detail {
		color: var(--color-lead);
		font-size: 0.875rem;
	}
	.item-actions,
	.form-buttons {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
	}
	.apply {
		display: grid;
		gap: 0.75rem;
		padding: 0.85rem;
		border: 1px solid var(--color-rule);
		border-radius: var(--radius-md, 0.625rem);
	}
</style>
