<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Link access: when the link opens and stops, where it goes after it stops, and a password. -->
<script lang="ts">
	import { onMount } from 'svelte';
	import TextInput from '../atoms/TextInput.svelte';

	interface Props {
		// ISO 8601 times, or empty for no bound.
		values: { startsAt: string; endsAt: string; endedDestination: string };
		// Prefix for the field IDs, unique on the page.
		idPrefix: string;
		// The link has a password now. An empty password field then keeps it.
		hasPassword?: boolean;
		error?: { message: string; field: string | null } | null;
		// The ID of a message that the form already shows. Without it, the error shows here.
		errorId?: string;
		// Why the workspace cannot set these, such as a plan that lacks them. The fields are then
		// read-only and send nothing, so an edit keeps what the link has; the boxes that remove the
		// times or the password still work.
		unavailable?: string | null;
	}

	let {
		values,
		idPrefix,
		hasPassword = false,
		error = null,
		errorId,
		unavailable = null
	}: Props = $props();

	const fieldNames = ['startsAt', 'endsAt', 'endedDestination', 'password'];
	const off = $derived(Boolean(unavailable));
	const invalid = (field: string) => error?.field === field;
	const describedBy = $derived(errorId ?? `${idPrefix}-access-error`);

	// The browser shows local time; the form sends the ISO time. Local values are set after
	// mount, so the server's time zone never reaches the page.
	let mounted = $state(false);
	let zone = $state('');
	let startsAt = $state('');
	let endsAt = $state('');
	let startsLocal = $state('');
	let endsLocal = $state('');

	function local(iso: string): string {
		if (!iso) return '';
		const time = new Date(iso);
		if (Number.isNaN(time.getTime())) return '';
		const pad = (value: number) => String(value).padStart(2, '0');
		return `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())}T${pad(time.getHours())}:${pad(time.getMinutes())}`;
	}

	function iso(value: string): string {
		if (!value) return '';
		const time = new Date(value);
		return Number.isNaN(time.getTime()) ? '' : time.toISOString();
	}

	// A time that the person did not change goes back as given, with its seconds, so it counts as
	// no change.
	const startsSent = $derived(
		!mounted || startsLocal === local(startsAt) ? startsAt : iso(startsLocal)
	);
	const endsSent = $derived(!mounted || endsLocal === local(endsAt) ? endsAt : iso(endsLocal));

	$effect.pre(() => {
		startsAt = values.startsAt;
		endsAt = values.endsAt;
		if (mounted) {
			startsLocal = local(values.startsAt);
			endsLocal = local(values.endsAt);
		}
	});

	let fieldset = $state<HTMLFieldSetElement>();

	onMount(() => {
		startsLocal = local(startsAt);
		endsLocal = local(endsAt);
		zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		mounted = true;
		// A form reset clears the boxes without an input event; clear the times it sends too.
		const form = fieldset?.form;
		const clear = () => {
			startsLocal = '';
			endsLocal = '';
		};
		form?.addEventListener('reset', clear);
		return () => form?.removeEventListener('reset', clear);
	});
</script>

<fieldset bind:this={fieldset} class="access" aria-describedby="{idPrefix}-access-hint">
	<legend>Start, end, and password <span class="optional">optional</span></legend>
	<p id="{idPrefix}-access-hint" class="hint">
		{#if unavailable}{unavailable}{:else}
			The link opens and stops at the times you set{zone ? ` (${zone} time)` : ''}. A password asks
			visitors for it before they go to the destination.
		{/if}
	</p>
	{#if !off}
		<input type="hidden" name="startsAt" value={startsSent} />
		<input type="hidden" name="endsAt" value={endsSent} />
	{/if}
	<div class="grid" class:off>
		<div class="field">
			<label for="{idPrefix}-starts">Opens</label>
			<TextInput
				id="{idPrefix}-starts"
				type="datetime-local"
				disabled={off}
				bind:value={startsLocal}
				invalid={invalid('startsAt')}
				aria-describedby={invalid('startsAt') ? describedBy : undefined}
			/>
		</div>
		<div class="field">
			<label for="{idPrefix}-ends">Stops</label>
			<TextInput
				id="{idPrefix}-ends"
				type="datetime-local"
				disabled={off}
				bind:value={endsLocal}
				invalid={invalid('endsAt')}
				aria-describedby={invalid('endsAt') ? describedBy : undefined}
			/>
		</div>
	</div>
	<div class="field" class:off>
		<label for="{idPrefix}-ended">After it stops, go to</label>
		<TextInput
			id="{idPrefix}-ended"
			name="endedDestination"
			type="url"
			inputmode="url"
			autocomplete="off"
			autocapitalize="none"
			spellcheck="false"
			maxlength={4096}
			placeholder="https://example.com/sold-out"
			disabled={off}
			value={values.endedDestination}
			invalid={invalid('endedDestination')}
			aria-describedby={invalid('endedDestination') ? describedBy : undefined}
		/>
	</div>
	<div class="field" class:off>
		<label for="{idPrefix}-password">Password</label>
		<TextInput
			id="{idPrefix}-password"
			name="password"
			type="password"
			autocomplete="new-password"
			minlength={4}
			maxlength={128}
			disabled={off}
			placeholder={hasPassword ? 'Leave empty to keep it' : 'No password'}
			invalid={invalid('password')}
			aria-describedby={invalid('password') ? describedBy : undefined}
		/>
	</div>
	{#if off && (values.startsAt || values.endsAt)}
		<label class="check">
			<input type="checkbox" name="removeTimes" />
			Remove the start and end times
		</label>
	{/if}
	{#if hasPassword}
		<label class="check">
			<input type="checkbox" name="removePassword" />
			Remove the password
		</label>
	{/if}
	{#if !errorId && error && fieldNames.some(invalid)}
		<p id="{idPrefix}-access-error" class="error" role="alert">{error.message}</p>
	{/if}
</fieldset>

<style>
	.access {
		display: grid;
		gap: 0.6rem;
		min-width: 0;
		margin: 0;
		padding: 0;
		border: 0;
	}
	.off {
		opacity: 0.6;
	}
	legend {
		padding: 0;
		color: var(--color-strong);
		font-size: 0.9375rem;
		font-weight: 600;
	}
	.optional {
		color: var(--color-lead);
		font-weight: 400;
	}
	.hint {
		color: var(--color-lead);
		font-size: 0.875rem;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
		gap: 0.75rem;
	}
	.field {
		display: grid;
		gap: 0.35rem;
		min-width: 0;
	}
	.field label {
		color: var(--color-strong);
		font-size: 0.875rem;
	}
	.check {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		color: var(--color-strong);
		font-size: 0.875rem;
	}
	.error {
		color: var(--color-danger);
		font-size: 0.875rem;
	}
</style>
