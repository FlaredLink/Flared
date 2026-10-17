<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import {
		automationsPerLink,
		maxApplyLinks,
		type ApplyAutomationLinkResult,
		type ApplyAutomationLinksResult,
		type Automation
	} from '@flared/contracts/automations';
	import { applyAutomationToLinks, automationErrorMessage, localDateTimeToIso } from './client';
	import { triggerText } from './text';
	import { shownWorkspace } from '../workspace/shown';
	import Button from '../atoms/Button.svelte';
	import Select from '../atoms/Select.svelte';
	import TextInput from '../atoms/TextInput.svelte';
	import Callout from '../molecules/Callout.svelte';
	import Dialog from '../molecules/Dialog.svelte';
	import FormField from '../molecules/FormField.svelte';

	interface Props {
		open: boolean;
		// The links to apply the template to: at most 100.
		linkIds: readonly string[];
		// The workspace's templates; only the ones that are on can be applied.
		automations: readonly Automation[];
		// The path of the /v1 API for this browser, such as "/api/v1".
		apiBase: string;
		// A link's name for the list of failures. Without it, the list shows link IDs.
		linkName?: (linkId: string) => string;
		// Where templates are created and turned on.
		automationsHref?: string;
		// Called after a request that applied the template to one link or more.
		onapplied?: (result: ApplyAutomationLinksResult) => void;
	}
	let {
		open = $bindable(),
		linkIds,
		automations,
		apiBase,
		linkName,
		automationsHref,
		onapplied
	}: Props = $props();
	const workspace = shownWorkspace();
	const numbers = new Intl.NumberFormat();

	let automationId = $state('');
	let endsAt = $state('');
	let pending = $state(false);
	let error = $state('');
	let errorField = $state<'automation' | 'endsAt' | null>(null);
	let result = $state.raw<ApplyAutomationLinksResult | null>(null);

	const usable = $derived(automations.filter((item) => item.enabled));
	const chosen = $derived(usable.find((item) => item.id === automationId) ?? null);
	const needsDate = $derived(chosen?.trigger.type === 'end_date');
	const endsIso = $derived(localDateTimeToIso(endsAt));
	const past = $derived(endsIso !== null && Date.parse(endsIso) <= Date.now());
	const counts = $derived.by(() => {
		const results = result?.results ?? [];
		return {
			applied: results.filter((item) => item.status === 'applied').length,
			unchanged: results.filter((item) => item.status === 'unchanged').length,
			failed: results.filter((item) => item.status === 'failed')
		};
	});
	const linksText = (count: number) => `${numbers.format(count)} ${count === 1 ? 'link' : 'links'}`;

	function reset() {
		automationId = '';
		endsAt = '';
		pending = false;
		error = '';
		errorField = null;
		result = null;
	}

	function failureText(item: ApplyAutomationLinkResult): string {
		switch (item.error?.code) {
			case 'NOT_FOUND':
				return 'This link no longer exists.';
			case 'LINK_BLOCKED':
				return 'Flared blocked this link for abuse.';
			case 'LINK_AUTOMATION_LIMIT_REACHED':
				return `This link already has ${automationsPerLink} automations.`;
			default:
				return item.error?.message ?? 'Flared could not apply the automation to this link.';
		}
	}

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		error = '';
		errorField = null;
		if (!chosen) {
			error = 'Choose an automation.';
			errorField = 'automation';
			return;
		}
		if (linkIds.length === 0 || linkIds.length > maxApplyLinks) {
			error = `Choose from 1 to ${maxApplyLinks} links.`;
			return;
		}
		if (needsDate && endsIso === null) {
			error = 'Choose the date and time the automation runs.';
			errorField = 'endsAt';
			return;
		}
		pending = true;
		const response = await applyAutomationToLinks(
			apiBase,
			chosen.id,
			[...linkIds],
			needsDate ? endsIso : null,
			workspace()
		);
		pending = false;
		if (!response.ok) {
			error = automationErrorMessage(response.failure);
			errorField = response.failure.field === 'endsAt' ? 'endsAt' : null;
			return;
		}
		result = response.value;
		if (response.value.results.some((item) => item.status !== 'failed'))
			onapplied?.(response.value);
	}
</script>

<Dialog bind:open id="apply-automation-title" title="Apply an automation" onclose={reset}>
	{#if result}
		<div class="result" role="status">
			{#if counts.applied > 0}<p>
					Applied {chosen?.name ?? 'the automation'} to {linksText(counts.applied)}.
				</p>{/if}
			{#if counts.unchanged > 0}<p>
					{linksText(counts.unchanged)}
					{counts.unchanged === 1 ? 'already has' : 'already have'} it with the same settings.
				</p>{/if}
			{#if counts.failed.length > 0}<p>
					Flared could not apply it to {linksText(counts.failed.length)}.
				</p>{/if}
		</div>
		{#if counts.failed.length > 0}
			<ul class="failures" aria-label="Links that failed">
				{#each counts.failed as item (item.linkId)}
					<li>
						<span class="link">{linkName ? linkName(item.linkId) : item.linkId}</span>
						<span>{failureText(item)}</span>
					</li>
				{/each}
			</ul>
		{/if}
		<Button variant="primary" size="lg" wide onclick={() => (open = false)}>Done</Button>
	{:else if usable.length === 0}
		<p class="note">
			No automation is on.
			{#if automationsHref}<a href={automationsHref}>Open Automations</a>{:else}The workspace owner
				creates automations and turns them on.{/if}
		</p>
		<Button size="lg" wide onclick={() => (open = false)}>Close</Button>
	{:else}
		<form class="apply" onsubmit={submit} novalidate>
			<p class="note">
				{linkIds.length === 1
					? '1 link chosen.'
					: `${numbers.format(linkIds.length)} links chosen.`}
				The automation runs once on each link when its trigger is met.
			</p>
			<FormField
				for="apply-automation"
				label="Automation"
				error={errorField === 'automation' ? error : null}
			>
				<Select
					id="apply-automation"
					bind:value={automationId}
					aria-invalid={errorField === 'automation' || undefined}
				>
					<option value="" disabled>Choose an automation</option>
					{#each usable as automation (automation.id)}
						<option value={automation.id}>{automation.name}</option>
					{/each}
				</Select>
			</FormField>
			{#if chosen}<p class="when">When: {triggerText(chosen.trigger)}</p>{/if}
			{#if needsDate}
				<FormField
					for="apply-automation-ends"
					label="End date and time"
					hint="In your time zone."
					error={errorField === 'endsAt' ? error : null}
				>
					<TextInput
						id="apply-automation-ends"
						type="datetime-local"
						bind:value={endsAt}
						required
						invalid={errorField === 'endsAt'}
						aria-describedby={errorField === 'endsAt'
							? 'apply-automation-ends-hint apply-automation-ends-error'
							: 'apply-automation-ends-hint'}
					/>
				</FormField>
				{#if past}
					<Callout tone="warning">
						<p>This time has passed, so the automation runs on these links soon.</p>
					</Callout>
				{/if}
			{/if}
			{#if error && errorField === null}<p class="error" role="alert">{error}</p>{/if}
			<div class="buttons">
				<Button type="submit" variant="primary" size="lg" wide disabled={pending}
					>{pending ? 'Applying…' : 'Apply'}</Button
				>
				<Button size="lg" wide onclick={() => (open = false)}>Cancel</Button>
			</div>
		</form>
	{/if}
</Dialog>

<style>
	.apply {
		display: grid;
		gap: 1rem;
	}
	.note,
	.when {
		color: var(--color-lead);
		font-size: 0.9375rem;
	}
	.note a {
		color: var(--color-link);
		text-decoration: underline;
	}
	.result {
		display: grid;
		gap: 0.35rem;
		margin-bottom: 1rem;
		color: var(--color-strong);
		font-size: 0.9375rem;
	}
	.failures {
		display: grid;
		gap: 0.5rem;
		max-height: 16rem;
		margin: 0 0 1rem;
		padding: 0;
		overflow-y: auto;
		list-style: none;
		font-size: 0.875rem;
	}
	.failures li {
		display: grid;
		gap: 0.1rem;
		color: var(--color-ink);
	}
	.link {
		overflow-wrap: anywhere;
		color: var(--color-strong);
		font-weight: 600;
	}
	.error {
		color: var(--color-danger);
		font-size: 0.875rem;
	}
	.buttons {
		display: grid;
		gap: 0.6rem;
	}
</style>
