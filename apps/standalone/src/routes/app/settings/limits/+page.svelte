<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import UsageMeters from '@flared/ui/usage/UsageMeters.svelte';
	import { limitFields, toLimitsView, type Limits } from '$lib/limits';
	import { useSettings } from '$lib/settings';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const settings = useSettings();
	const numbers = new Intl.NumberFormat();
	// The owner changes the limits; a member sees them.
	const owner = $derived(data.workspace?.role === 'owner');

	// Limits.
	let limits = $state<Limits | null>(null);
	let limitsView = $state<PageData['limits']>(null);
	let limitsPending = $state(false);
	let limitsError = $state('');
	$effect(() => {
		limitsView = data.limits;
		limits = data.limits ? { ...data.limits.limits } : null;
	});

	async function saveLimits() {
		if (!limits) return;
		limitsPending = true;
		limitsError = '';
		try {
			const response = await fetch('/api/settings/limits', {
				method: 'POST',
				credentials: 'same-origin',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(limits)
			});
			const body: unknown = await response.json().catch(() => null);
			if (response.ok) {
				limitsView = toLimitsView(body) ?? limitsView;
				await invalidateAll();
				return;
			}
			const error =
				typeof body === 'object' && body !== null && 'error' in body ? body.error : null;
			const code =
				typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
			if (code === 'REAUTH_REQUIRED') return settings.askReauth();
			limitsError =
				code === 'VALIDATION_FAILED'
					? 'Each limit must be a whole number in its range.'
					: 'We could not change the limits. Try again.';
		} catch {
			limitsError = 'We could not reach the app. Try again.';
		} finally {
			limitsPending = false;
		}
	}

	function megabytes(bytes: number): string {
		return `${numbers.format(Math.round((bytes / 1_000_000) * 10) / 10)} MB`;
	}
</script>

<section id="limits" class="section anchor" aria-labelledby="limits-heading">
	<h2 id="limits-heading">Limits and usage</h2>
	{#if data.usage}<UsageMeters usage={data.usage} />{/if}
	{#if limits && limitsView}
		<p>
			{owner
				? 'Lower limits never stop existing links, domains, or members; they block new ones. Higher limits use more of your Cloudflare plan; see docs/self-hosting/limits.md.'
				: 'Only the workspace owner can change the limits.'}
		</p>
		<form
			class="limits-form"
			onsubmit={(event) => {
				event.preventDefault();
				void saveLimits();
			}}
		>
			{#each limitFields as field}
				<div class="field">
					<label for={`limit-${field.key}`}>{field.label}</label>
					<input
						id={`limit-${field.key}`}
						type="number"
						inputmode="numeric"
						min={limitsView.bounds[field.key].min}
						max={limitsView.bounds[field.key].max}
						step="1"
						required
						readonly={!owner}
						bind:value={limits[field.key]}
					/>
					<small
						>{numbers.format(limitsView.bounds[field.key].min)} to {numbers.format(
							limitsView.bounds[field.key].max
						)}
						{field.unit}</small
					>
				</div>
			{/each}
			{#if limitsError}<p class="error" role="alert">{limitsError}</p>{/if}
			<div class="button-row">
				{#if owner}
					<button class="button primary" type="submit" disabled={limitsPending}
						>{limitsPending ? 'Saving…' : 'Save limits'}</button
					>
				{/if}
				{#if limitsView.pending}
					<p role="status">
						Pending: the new limits are saved and apply once both databases hold them.
						<button class="link-button" type="button" onclick={() => invalidateAll()}
							>Check again</button
						>
					</p>
				{/if}
			</div>
		</form>
		{#if limitsView.analyticsBytes !== null}
			<p>
				The analytics database uses {megabytes(limitsView.analyticsBytes)}. One D1 database holds up
				to 500 MB on Workers Free and 10 GB on Workers Paid. Workers Free also limits D1 reads, D1
				writes, and Queue operations each day.
			</p>
		{/if}
	{:else}
		<section class="notice" role="alert">
			<h2>We couldn’t load the limits</h2>
			<p>Refresh the page to try again.</p>
		</section>
	{/if}
</section>

<style>
	.limits-form {
		display: grid;
		gap: 1rem;
		max-width: 24rem;
	}
	.link-button {
		padding: 0;
		border: 0;
		background: none;
		color: var(--color-accent-ink);
		font-weight: 600;
		text-decoration: underline;
	}
</style>
