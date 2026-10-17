<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import { untrack } from 'svelte';
	import {
		automationActionTypes,
		automationNameMaxLength,
		automationTriggerTypes,
		maxTriggerClicks,
		maxTriggerDays,
		minTriggerClicks,
		minTriggerDays,
		parseAutomationName,
		triggerClickStep,
		type Automation,
		type AutomationAction,
		type AutomationActionType,
		type AutomationTrigger,
		type AutomationTriggerType,
		type CreateAutomationInput
	} from '@flared/contracts/automations';
	import { LinkInputError, parseDestination } from '@flared/contracts/links';
	import { endpointLabel } from '../webhooks/client';
	import { actionLabels, triggerLabels, type AutomationEndpoint } from './text';
	import Glyph, { type GlyphName } from '../icons/Glyph.svelte';
	import Button from '../atoms/Button.svelte';
	import Checkbox from '../atoms/Checkbox.svelte';
	import Select from '../atoms/Select.svelte';
	import TextInput from '../atoms/TextInput.svelte';
	import ChoiceCard from '../molecules/ChoiceCard.svelte';
	import FormField from '../molecules/FormField.svelte';

	interface Props {
		// The template to edit; without it the form creates a new one. The page keys the form by
		// the template, so the fields start from it once.
		initial?: Automation;
		// The webhook endpoints the send-webhook action can use, or null when the page could not
		// read them.
		endpoints: readonly AutomationEndpoint[] | null;
		// What this installation offers, in the server's order.
		actionTypes: readonly AutomationActionType[];
		triggerTypes: readonly AutomationTriggerType[];
		// Where webhook endpoints are added.
		webhooksHref?: string;
		pending: boolean;
		// A problem the server reported, and the field it names.
		error: string;
		errorField: string | null;
		onsubmit: (input: CreateAutomationInput) => void;
		oncancel: () => void;
	}
	let {
		initial,
		endpoints,
		actionTypes,
		triggerTypes,
		webhooksHref,
		pending,
		error,
		errorField,
		onsubmit,
		oncancel
	}: Props = $props();

	type Field = 'name' | 'trigger' | 'actions' | 'destination' | 'endpointId';
	const fields: readonly string[] = ['name', 'trigger', 'actions', 'destination', 'endpointId'];
	const clickPresets = [100, 500, 1000, 5000, 10_000];
	const triggerIcons: Record<AutomationTriggerType, GlyphName> = {
		end_date: 'calendar',
		link_age: 'hourglass',
		clicks: 'cursorClick',
		destination_down: 'warningCircle'
	};
	const numbers = new Intl.NumberFormat();

	function startValues(from: Automation | undefined) {
		const trigger = from?.trigger;
		const action = <T extends AutomationActionType>(type: T) =>
			from?.actions.find(
				(item): item is Extract<AutomationAction, { type: T }> => item.type === type
			);
		const clicks = trigger?.type === 'clicks' ? trigger.clicks : 1000;
		const preset = clickPresets.includes(clicks);
		const endpointId = action('send_webhook')?.endpointId ?? '';
		return {
			editing: from !== undefined,
			name: from?.name ?? '',
			triggerType: trigger?.type ?? triggerTypes[0] ?? 'end_date',
			days: String(trigger?.type === 'link_age' ? trigger.days : 90),
			clicks: preset ? String(clicks) : 'custom',
			customClicks: preset ? '' : String(clicks),
			chosen: from?.actions.map((item) => item.type) ?? [],
			destination: action('change_destination')?.destination ?? '',
			// A deleted endpoint is not offered, so the person chooses another.
			endpointId: endpoints?.some((item) => item.id === endpointId) ? endpointId : ''
		};
	}
	const start = untrack(() => startValues(initial));
	const editing = start.editing;
	const fixedTrigger = untrack(() => initial?.trigger);

	let name = $state(start.name);
	let triggerType = $state<AutomationTriggerType>(start.triggerType);
	let days = $state(start.days);
	let clicks = $state(start.clicks);
	let customClicks = $state(start.customClicks);
	let chosen = $state<AutomationActionType[]>(start.chosen);
	let destination = $state(start.destination);
	let endpointId = $state(start.endpointId);
	let localError = $state<{ field: Field; text: string } | null>(null);
	let nameInput = $state<HTMLInputElement>();
	// The panel opens with the keyboard in the name field.
	$effect(() => {
		nameInput?.focus();
	});

	// The triggers and actions this installation offers, and any the template already uses.
	const shownTriggers = $derived(
		automationTriggerTypes.filter((type) => triggerTypes.includes(type))
	);
	const shownActions = $derived(
		automationActionTypes.filter(
			(type) => actionTypes.includes(type) || start.chosen.includes(type)
		)
	);
	const noEndpoints = $derived(endpoints === null || endpoints.length === 0);

	const fieldError = (field: Field) =>
		localError?.field === field ? localError.text : errorField === field ? error : null;
	// A server error that names no field of this form goes above the buttons.
	const formError = $derived(
		localError === null && error && !fields.includes(errorField ?? '') ? error : ''
	);
	const describedBy = (id: string, field: Field, hint = true) =>
		[hint ? `${id}-hint` : '', fieldError(field) ? `${id}-error` : ''].filter(Boolean).join(' ') ||
		undefined;

	function toggle(type: AutomationActionType, checked: boolean) {
		chosen = automationActionTypes.filter((item) =>
			item === type ? checked : chosen.includes(item)
		);
	}

	function readTrigger(): AutomationTrigger | string {
		switch (triggerType) {
			case 'link_age': {
				const value = Number(days.trim());
				return Number.isSafeInteger(value) && value >= minTriggerDays && value <= maxTriggerDays
					? { type: 'link_age', days: value }
					: `Use a whole number of days from ${minTriggerDays} to ${numbers.format(maxTriggerDays)}.`;
			}
			case 'clicks': {
				const value = Number(clicks === 'custom' ? customClicks.replaceAll(/[\s,]/g, '') : clicks);
				return Number.isSafeInteger(value) &&
					value >= minTriggerClicks &&
					value <= maxTriggerClicks &&
					value % triggerClickStep === 0
					? { type: 'clicks', clicks: value }
					: `Use a multiple of ${triggerClickStep} clicks from ${numbers.format(minTriggerClicks)} to ${numbers.format(maxTriggerClicks)}.`;
			}
			case 'end_date':
				return { type: 'end_date' };
			case 'destination_down':
				return { type: 'destination_down' };
		}
	}

	function submit(event: SubmitEvent) {
		event.preventDefault();
		localError = null;
		let checkedName: string;
		try {
			checkedName = parseAutomationName(name);
		} catch (problem) {
			if (!(problem instanceof LinkInputError)) throw problem;
			localError = { field: 'name', text: problem.message };
			nameInput?.focus();
			return;
		}
		const trigger = readTrigger();
		if (typeof trigger === 'string') {
			localError = { field: 'trigger', text: trigger };
			return;
		}
		if (chosen.length === 0) {
			localError = { field: 'actions', text: 'Choose at least one action.' };
			return;
		}
		const actions: AutomationAction[] = [];
		for (const type of chosen) {
			if (type === 'change_destination') {
				try {
					actions.push({ type, destination: parseDestination(destination) });
				} catch (problem) {
					if (!(problem instanceof LinkInputError)) throw problem;
					localError = { field: 'destination', text: problem.message };
					return;
				}
			} else if (type === 'send_webhook') {
				if (!endpointId) {
					localError = { field: 'endpointId', text: 'Choose a webhook endpoint.' };
					return;
				}
				actions.push({ type, endpointId });
			} else actions.push({ type });
		}
		onsubmit({ name: checkedName, trigger, actions });
	}
</script>

<form class="automation-form" onsubmit={submit} novalidate>
	<h3>{editing ? 'Edit the automation' : 'New automation'}</h3>
	<FormField for="automation-name" label="Name" error={fieldError('name')}>
		<TextInput
			id="automation-name"
			bind:value={name}
			bind:input={nameInput}
			maxlength={automationNameMaxLength}
			placeholder="End of campaign"
			autocomplete="off"
			required
			invalid={fieldError('name') !== null}
			aria-describedby={fieldError('name') ? 'automation-name-error' : undefined}
		/>
	</FormField>

	<fieldset aria-describedby={fieldError('trigger') ? 'automation-trigger-error' : undefined}>
		<legend>When</legend>
		{#if fixedTrigger}
			<p class="fixed">
				<Glyph name={triggerIcons[fixedTrigger.type]} size={20} />{triggerLabels[fixedTrigger.type]
					.label}
			</p>
			<p class="hint">The trigger stays the same. Create a new automation for another trigger.</p>
		{:else}
			<div class="choices">
				{#each shownTriggers as type (type)}
					{#snippet icon()}<Glyph name={triggerIcons[type]} size={22} />{/snippet}
					<ChoiceCard
						name="automation-trigger"
						value={type}
						checked={triggerType === type}
						label={triggerLabels[type].label}
						description={triggerLabels[type].description}
						layout="row"
						{icon}
						onselect={() => (triggerType = type)}
					/>
				{/each}
			</div>
		{/if}
		{#if triggerType === 'link_age'}
			<FormField
				for="automation-days"
				label="Days after the link is created"
				hint="A whole number from 1 to 3,650."
				error={fieldError('trigger')}
			>
				<TextInput
					id="automation-days"
					type="number"
					inputmode="numeric"
					bind:value={days}
					min={minTriggerDays}
					max={maxTriggerDays}
					step={1}
					invalid={fieldError('trigger') !== null}
					aria-describedby={describedBy('automation-days', 'trigger')}
				/>
			</FormField>
		{:else if triggerType === 'clicks'}
			<FormField
				for="automation-clicks"
				label="Run when a link passes"
				error={clicks === 'custom' ? null : fieldError('trigger')}
			>
				<Select id="automation-clicks" bind:value={clicks}>
					{#each clickPresets as preset (preset)}
						<option value={String(preset)}>{numbers.format(preset)} clicks</option>
					{/each}
					<option value="custom">Other number</option>
				</Select>
			</FormField>
			{#if clicks === 'custom'}
				<FormField
					for="automation-clicks-custom"
					label="Clicks"
					hint="A multiple of 100, up to 100,000,000."
					error={fieldError('trigger')}
				>
					<TextInput
						id="automation-clicks-custom"
						type="number"
						inputmode="numeric"
						bind:value={customClicks}
						min={minTriggerClicks}
						max={maxTriggerClicks}
						step={triggerClickStep}
						placeholder="2500"
						invalid={fieldError('trigger') !== null}
						aria-describedby={describedBy('automation-clicks-custom', 'trigger')}
					/>
				</FormField>
			{/if}
		{:else if fieldError('trigger')}
			<p class="error" id="automation-trigger-error" role="alert">{fieldError('trigger')}</p>
		{/if}
	</fieldset>

	<fieldset aria-describedby={fieldError('actions') ? 'automation-actions-error' : undefined}>
		<legend>Then</legend>
		<p class="hint">Flared runs the chosen actions in this order, once for each link.</p>
		<div class="actions">
			{#each shownActions as type (type)}
				{@const checked = chosen.includes(type)}
				<div class="action">
					<Checkbox
						{checked}
						disabled={type === 'send_webhook' && noEndpoints && !checked}
						hint={type === 'send_webhook' && noEndpoints
							? endpoints === null
								? 'Webhook endpoints are not available right now.'
								: 'Add a webhook endpoint first.'
							: type === 'email_owner'
								? 'One email for each run, with the links it changed.'
								: undefined}
						onchange={(event) => toggle(type, event.currentTarget.checked)}
						>{actionLabels[type]}</Checkbox
					>
					{#if type === 'send_webhook' && noEndpoints && webhooksHref}
						<a class="more" href={webhooksHref}>Open webhooks<Glyph name="arrow" size={16} /></a>
					{/if}
					{#if checked && type === 'change_destination'}
						<div class="nested">
							<FormField
								for="automation-destination"
								label="New destination"
								hint="Visitors go here after the automation runs."
								error={fieldError('destination')}
							>
								<TextInput
									id="automation-destination"
									type="url"
									bind:value={destination}
									placeholder="https://example.com/offers"
									autocomplete="off"
									spellcheck="false"
									mono
									invalid={fieldError('destination') !== null}
									aria-describedby={describedBy('automation-destination', 'destination')}
								/>
							</FormField>
						</div>
					{:else if checked && type === 'send_webhook' && endpoints && endpoints.length > 0}
						<div class="nested">
							<FormField
								for="automation-endpoint"
								label="Endpoint"
								hint="Flared sends an automation.triggered event to this endpoint."
								error={fieldError('endpointId')}
							>
								<Select
									id="automation-endpoint"
									bind:value={endpointId}
									aria-invalid={fieldError('endpointId') !== null || undefined}
									aria-describedby={describedBy('automation-endpoint', 'endpointId')}
								>
									<option value="" disabled>Choose an endpoint</option>
									{#each endpoints as endpoint (endpoint.id)}
										<option value={endpoint.id}>{endpointLabel(endpoint.url)}</option>
									{/each}
								</Select>
							</FormField>
						</div>
					{:else if checked && type === 'send_webhook' && fieldError('endpointId')}
						<p class="error" role="alert">{fieldError('endpointId')}</p>
					{/if}
				</div>
			{/each}
		</div>
		{#if fieldError('actions')}
			<p class="error" id="automation-actions-error" role="alert">{fieldError('actions')}</p>
		{/if}
	</fieldset>

	{#if formError}<p class="error" role="alert">{formError}</p>{/if}
	<div class="buttons">
		<Button type="submit" variant="primary" size="lg" wide disabled={pending}
			>{editing
				? pending
					? 'Saving…'
					: 'Save changes'
				: pending
					? 'Creating…'
					: 'Create automation'}</Button
		>
		<Button size="lg" wide onclick={oncancel}>Cancel</Button>
	</div>
</form>

<style>
	.automation-form {
		display: grid;
		gap: 1.1rem;
	}
	.automation-form h3 {
		color: var(--color-strong);
		font-size: 1.75rem;
		font-weight: 750;
		letter-spacing: -0.035em;
		line-height: 1.15;
	}
	fieldset {
		display: grid;
		gap: 0.6rem;
		min-width: 0;
		margin: 0;
		padding: 0;
		border: 0;
	}
	legend {
		margin-bottom: 0.6rem;
		padding: 0;
		color: var(--color-strong);
		font-size: 1.0625rem;
		font-weight: 650;
	}
	.choices {
		display: grid;
		gap: 0.5rem;
	}
	.fixed {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		color: var(--color-strong);
		font-size: 1rem;
		font-weight: 600;
	}
	.hint {
		color: var(--color-lead);
		font-size: 0.875rem;
	}
	.actions {
		display: grid;
		gap: 0.5rem;
	}
	.action {
		display: grid;
		gap: 0.5rem;
	}
	/* An action's own field sits under its checkbox label. */
	.nested {
		margin-left: 1.85rem;
	}
	.more {
		display: inline-flex;
		align-items: center;
		justify-self: start;
		gap: 0.35rem;
		margin-left: 1.85rem;
		color: var(--color-link);
		font-size: 0.875rem;
	}
	.more:hover {
		text-decoration: underline;
		text-underline-offset: 3px;
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
