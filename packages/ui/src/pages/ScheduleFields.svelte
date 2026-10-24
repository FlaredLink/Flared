<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import { onMount } from 'svelte';
	import TextInput from '../atoms/TextInput.svelte';

	interface Props {
		idPrefix: string;
		// ISO 8601 times, or '' for no bound.
		startsAt: string;
		endsAt: string;
		error?: string | null;
	}

	let { idPrefix, startsAt = $bindable(), endsAt = $bindable(), error = null }: Props = $props();

	// The boxes show local time, which only the browser knows; the server renders them empty.
	let zone = $state('');
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

	onMount(() => {
		zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		startsLocal = local(startsAt);
		endsLocal = local(endsAt);
	});
</script>

<div class="schedule">
	<p class="hint" id="{idPrefix}-schedule-hint">
		Show this block only between these times{zone ? ` (${zone} time)` : ''}. Leave a box empty for
		no limit.
	</p>
	<div class="grid">
		<div class="field">
			<label for="{idPrefix}-starts">Show from</label>
			<TextInput
				id="{idPrefix}-starts"
				type="datetime-local"
				bind:value={startsLocal}
				oninput={(event) => (startsAt = iso(event.currentTarget.value))}
				aria-describedby="{idPrefix}-schedule-hint"
			/>
		</div>
		<div class="field">
			<label for="{idPrefix}-ends">Hide after</label>
			<TextInput
				id="{idPrefix}-ends"
				type="datetime-local"
				bind:value={endsLocal}
				oninput={(event) => (endsAt = iso(event.currentTarget.value))}
				invalid={error !== null}
				aria-describedby="{idPrefix}-schedule-hint"
			/>
		</div>
	</div>
	{#if error}<p class="error" role="alert">{error}</p>{/if}
</div>

<style>
	.schedule {
		display: grid;
		gap: 0.5rem;
	}
	.grid {
		display: grid;
		gap: 0.5rem;
	}
	.field {
		display: grid;
		gap: 0.25rem;
	}
	label {
		color: var(--color-strong);
		font-size: 0.875rem;
		font-weight: 500;
	}
	.hint {
		color: var(--color-lead);
		font-size: 0.8125rem;
	}
	.error {
		color: var(--color-danger);
		font-size: 0.875rem;
	}
	@media (min-width: 40rem) {
		.grid {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}
</style>
