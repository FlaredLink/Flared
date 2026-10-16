<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts" module>
	import type { SubscribableWebhookEvent } from '@flared/contracts/webhooks';

	export const eventLabels: Record<SubscribableWebhookEvent, string> = {
		'link.created': 'Link created',
		'link.updated': 'Link edited',
		'link.disabled': 'Link turned off',
		'link.enabled': 'Link turned on',
		'link.click_milestone': 'Click milestone'
	};
</script>

<script lang="ts">
	import { untrack } from 'svelte';
	import {
		defaultMilestoneInterval,
		maxMilestoneInterval,
		maxWebhookUrlLength,
		milestoneStep,
		minMilestoneInterval,
		parseMilestoneInterval,
		parseWebhookUrl,
		type CreateWebhookInput,
		type WebhookEndpoint
	} from '@flared/contracts/webhooks';
	import { LinkInputError } from '@flared/contracts/links';
	import Button from '../atoms/Button.svelte';
	import Checkbox from '../atoms/Checkbox.svelte';
	import Select from '../atoms/Select.svelte';
	import TextInput from '../atoms/TextInput.svelte';
	import Callout from '../molecules/Callout.svelte';
	import FormField from '../molecules/FormField.svelte';

	interface Props {
		// The endpoint to edit; without it the form adds a new one. The page keys the form by the
		// endpoint, so the fields start from it once.
		endpoint?: WebhookEndpoint;
		// The events the server offers, in its order.
		eventTypes: readonly SubscribableWebhookEvent[];
		pending: boolean;
		// A problem the server reported, and the field it names.
		error: string;
		errorField: string | null;
		onsubmit: (input: CreateWebhookInput) => void;
		oncancel: () => void;
	}
	let { endpoint, eventTypes, pending, error, errorField, onsubmit, oncancel }: Props = $props();

	const presets = [100, 200, 500, 1000, 5000, 10_000];
	const numbers = new Intl.NumberFormat();

	function startValues(from: WebhookEndpoint | undefined) {
		const stored = from?.milestoneInterval ?? null;
		const preset = stored === null || presets.includes(stored);
		return {
			editing: from !== undefined,
			url: from?.url ?? '',
			events: from
				? [...from.events]
				: (['link.created', 'link.updated', 'link.disabled', 'link.enabled'] as const),
			interval: preset ? String(stored ?? defaultMilestoneInterval) : 'custom',
			custom: preset ? '' : String(stored)
		};
	}
	const start = untrack(() => startValues(endpoint));
	const editing = start.editing;

	let url = $state(start.url);
	let events = $state<SubscribableWebhookEvent[]>([...start.events]);
	let interval = $state(start.interval);
	let custom = $state(start.custom);
	let localError = $state<{ field: 'url' | 'events' | 'milestoneInterval'; text: string } | null>(
		null
	);
	let urlInput = $state<HTMLInputElement>();
	// The panel opens with the keyboard in the URL field.
	$effect(() => {
		urlInput?.focus();
	});

	const milestones = $derived(events.includes('link.click_milestone'));
	const fieldError = (field: string) =>
		localError?.field === field ? localError.text : errorField === field ? error : null;
	// A server error that names no field of this form goes above the buttons.
	const formError = $derived(
		localError === null &&
			error &&
			!['url', 'events', 'milestoneInterval'].includes(errorField ?? '')
			? error
			: ''
	);

	function toggle(event: SubscribableWebhookEvent, checked: boolean) {
		events = eventTypes.filter((item) => (item === event ? checked : events.includes(item)));
	}

	function submit(event: SubmitEvent) {
		event.preventDefault();
		localError = null;
		let checkedUrl: string;
		let milestoneInterval: number | null = null;
		try {
			// The server also refuses its own hostnames; the browser does not know them.
			checkedUrl = parseWebhookUrl(url, []);
		} catch (problem) {
			if (!(problem instanceof LinkInputError)) throw problem;
			localError = { field: 'url', text: problem.message };
			urlInput?.focus();
			return;
		}
		if (events.length === 0) {
			localError = { field: 'events', text: 'Choose at least one event.' };
			return;
		}
		if (milestones) {
			try {
				milestoneInterval = parseMilestoneInterval(
					interval === 'custom' ? Number(custom.replaceAll(/[\s,]/g, '')) : Number(interval)
				);
			} catch (problem) {
				if (!(problem instanceof LinkInputError)) throw problem;
				localError = { field: 'milestoneInterval', text: problem.message };
				return;
			}
		}
		onsubmit({ url: checkedUrl, events, milestoneInterval });
	}
</script>

<form class="create" onsubmit={submit} novalidate>
	<h3>{editing ? 'Edit the endpoint' : 'Add an endpoint'}</h3>
	<FormField
		for="webhook-url"
		label="Endpoint URL"
		hint="An https address that accepts POST requests."
		error={fieldError('url')}
	>
		<TextInput
			id="webhook-url"
			type="url"
			bind:value={url}
			bind:input={urlInput}
			maxlength={maxWebhookUrlLength}
			placeholder="https://example.com/hooks/flared"
			autocomplete="off"
			spellcheck="false"
			mono
			required
			invalid={fieldError('url') !== null}
			aria-describedby={fieldError('url')
				? 'webhook-url-hint webhook-url-error'
				: 'webhook-url-hint'}
		/>
	</FormField>
	<fieldset aria-describedby={fieldError('events') ? 'webhook-events-error' : undefined}>
		<legend>Events</legend>
		<div class="checks">
			{#each eventTypes as type (type)}
				<Checkbox
					checked={events.includes(type)}
					hint={type}
					onchange={(event) => toggle(type, event.currentTarget.checked)}
					>{eventLabels[type]}</Checkbox
				>
			{/each}
		</div>
		{#if fieldError('events')}
			<p class="error" id="webhook-events-error" role="alert">{fieldError('events')}</p>
		{/if}
	</fieldset>
	{#if milestones}
		<FormField
			for="webhook-interval"
			label="Send a milestone every"
			hint="Each link gets an event when its clicks reach a multiple of this number."
			error={interval === 'custom' ? null : fieldError('milestoneInterval')}
		>
			<Select id="webhook-interval" bind:value={interval}>
				{#each presets as preset (preset)}
					<option value={String(preset)}>{numbers.format(preset)} clicks</option>
				{/each}
				<option value="custom">Other number</option>
			</Select>
		</FormField>
		{#if interval === 'custom'}
			<FormField
				for="webhook-interval-custom"
				label="Clicks"
				hint="A multiple of 100, up to 1,000,000."
				error={fieldError('milestoneInterval')}
			>
				<TextInput
					id="webhook-interval-custom"
					type="number"
					inputmode="numeric"
					bind:value={custom}
					min={minMilestoneInterval}
					max={maxMilestoneInterval}
					step={milestoneStep}
					placeholder="2500"
					invalid={fieldError('milestoneInterval') !== null}
				/>
			</FormField>
		{/if}
	{/if}
	{#if !editing}
		<Callout tone="warning" icon="key">
			<p>Flared shows the signing secret once, after you add the endpoint.</p>
		</Callout>
	{/if}
	{#if formError}<p class="error" role="alert">{formError}</p>{/if}
	<div class="buttons">
		<Button type="submit" variant="primary" size="lg" wide disabled={pending}
			>{editing
				? pending
					? 'Saving…'
					: 'Save changes'
				: pending
					? 'Adding…'
					: 'Add endpoint'}</Button
		>
		<Button size="lg" wide onclick={oncancel}>Cancel</Button>
	</div>
</form>

<style>
	.create {
		display: grid;
		gap: 1.1rem;
	}
	.create h3 {
		color: var(--color-strong);
		font-size: 1.75rem;
		font-weight: 750;
		letter-spacing: -0.035em;
		line-height: 1.15;
	}
	fieldset {
		display: grid;
		gap: 0.3rem;
		margin: 0;
		padding: 0;
		border: 0;
	}
	legend {
		padding: 0;
		color: var(--color-strong);
		font-size: 1.0625rem;
		font-weight: 650;
	}
	.checks {
		display: grid;
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
