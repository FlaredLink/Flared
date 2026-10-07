<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import ConnectedAppList from '@flared/ui/oauth/ConnectedAppList.svelte';
	import DeleteAccount from '@flared/ui/account/DeleteAccount.svelte';
	import ExportPanel from '@flared/ui/export/ExportPanel.svelte';
	import PasskeyList from '@flared/ui/passkeys/PasskeyList.svelte';
	import TokenList from '@flared/ui/tokens/TokenList.svelte';
	import UsageMeters from '@flared/ui/usage/UsageMeters.svelte';
	import {
		confirmWithPasskey,
		passkeyErrorMessage,
		passkeysSupported
	} from '@flared/ui/passkeys/client';
	import { authErrorMessage, postJson } from '$lib/auth-client';
	import { limitFields, toLimitsView, type Limits } from '$lib/limits';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const account = $derived(
		data.auth.status === 'authenticated' ? data.auth.principal.user.name : ''
	);
	const numbers = new Intl.NumberFormat();

	// Confirming it's you: the password, or a passkey of this account.
	let reauthOpen = $state(false);
	let reauthPassword = $state('');
	let reauthPending = $state(false);
	let reauthError = $state('');
	let reauthHeading = $state<HTMLHeadingElement>();
	let supported = $state(false);
	const canUsePasskey = $derived(supported && (data.passkeys?.passkeys.length ?? 0) > 0);

	onMount(() => {
		supported = passkeysSupported();
	});

	// The panel sits at the top of the page, so bring it into view from the section that asked.
	async function askReauth() {
		reauthOpen = true;
		await tick();
		reauthHeading?.scrollIntoView({ block: 'center' });
		reauthHeading?.focus({ preventScroll: true });
	}

	async function confirmPassword() {
		reauthPending = true;
		reauthError = '';
		const result = await postJson('/api/auth/reauth/password', { password: reauthPassword });
		reauthPending = false;
		if (!result.ok) {
			reauthError = authErrorMessage(result.code);
			return;
		}
		reauthPassword = '';
		reauthOpen = false;
		await invalidateAll();
	}

	async function confirmPasskey() {
		reauthPending = true;
		reauthError = '';
		const result = await confirmWithPasskey();
		reauthPending = false;
		if (!result.ok) {
			reauthError = passkeyErrorMessage(result.code);
			return;
		}
		reauthOpen = false;
		await invalidateAll();
	}

	// Password change.
	let currentPassword = $state('');
	let newPassword = $state('');
	let repeatPassword = $state('');
	let passwordPending = $state(false);
	let passwordMessage = $state('');
	let passwordError = $state('');

	async function changePassword() {
		passwordError = '';
		passwordMessage = '';
		if (newPassword !== repeatPassword) {
			passwordError = 'The new passwords do not match.';
			return;
		}
		passwordPending = true;
		const result = await postJson('/api/auth/password/change', { currentPassword, newPassword });
		passwordPending = false;
		if (!result.ok) {
			if (result.code === 'REAUTH_REQUIRED') return askReauth();
			passwordError =
				result.code === 'INVALID_REQUEST'
					? 'Use a new password of 12 to 128 characters.'
					: authErrorMessage(result.code);
			return;
		}
		currentPassword = '';
		newPassword = '';
		repeatPassword = '';
		passwordMessage = 'Your password changed. Every other session ended.';
		await invalidateAll();
	}

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
			if (code === 'REAUTH_REQUIRED') return askReauth();
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

<svelte:head><title>Settings · Flared</title></svelte:head>

<div class="page-head">
	<h1>Settings</h1>
	{#if account}<p>Signed in as <strong>{account}</strong></p>{/if}
</div>

{#if reauthOpen}
	<section class="section reauth" aria-labelledby="reauth-heading">
		<h2 id="reauth-heading" tabindex="-1" bind:this={reauthHeading}>Confirm it’s you</h2>
		<p>
			Changing credentials and limits needs a sign-in from the last 10 minutes. Enter your password{canUsePasskey
				? ' or use a passkey'
				: ''}.
		</p>
		<form
			class="field"
			onsubmit={(event) => {
				event.preventDefault();
				void confirmPassword();
			}}
		>
			<label for="reauth-password">Password</label>
			<input
				id="reauth-password"
				type="password"
				bind:value={reauthPassword}
				required
				autocomplete="current-password"
			/>
			<div class="button-row">
				<button class="button primary" type="submit" disabled={reauthPending}>Confirm</button>
				{#if canUsePasskey}
					<button
						class="button secondary"
						type="button"
						disabled={reauthPending}
						onclick={() => void confirmPasskey()}>Use a passkey</button
					>
				{/if}
				<button class="button secondary" type="button" onclick={() => (reauthOpen = false)}
					>Cancel</button
				>
			</div>
		</form>
		{#if reauthError}<p class="error" role="alert">{reauthError}</p>{/if}
	</section>
	<div class="divider"></div>
{/if}

<section class="section" aria-labelledby="password-heading">
	<h2 id="password-heading">Password</h2>
	<p>
		Changing your password ends every other session. Without email, a forgotten password is reset
		from the Cloudflare account.
	</p>
	<form
		class="password-form"
		onsubmit={(event) => {
			event.preventDefault();
			void changePassword();
		}}
	>
		<div class="field">
			<label for="current-password">Current password</label>
			<input
				id="current-password"
				type="password"
				bind:value={currentPassword}
				required
				autocomplete="current-password"
			/>
		</div>
		<div class="field">
			<label for="new-password">New password</label>
			<input
				id="new-password"
				type="password"
				bind:value={newPassword}
				required
				minlength="12"
				maxlength="128"
				autocomplete="new-password"
			/>
		</div>
		<div class="field">
			<label for="repeat-password">New password again</label>
			<input
				id="repeat-password"
				type="password"
				bind:value={repeatPassword}
				required
				autocomplete="new-password"
			/>
		</div>
		{#if passwordError}<p class="error" role="alert">{passwordError}</p>{/if}
		{#if passwordMessage}<p role="status">{passwordMessage}</p>{/if}
		<button class="button primary" type="submit" disabled={passwordPending}
			>{passwordPending ? 'Changing…' : 'Change password'}</button
		>
	</form>
</section>

<div class="divider"></div>

{#if data.passkeys}
	<PasskeyList
		page={data.passkeys}
		onChanged={() => invalidateAll()}
		onReauthRequired={() => void askReauth()}
	/>
{:else}
	<section class="notice" role="alert">
		<h2>We couldn’t load your passkeys</h2>
		<p>Refresh the page to try again.</p>
	</section>
{/if}

<div class="divider"></div>

{#if data.tokens}
	<TokenList
		page={data.tokens}
		apiBase="/api/v1"
		onChanged={() => invalidateAll()}
		onReauthRequired={() => void askReauth()}
	/>
{:else}
	<section class="notice" role="alert">
		<h2>We couldn’t load your API tokens</h2>
		<p>Refresh the page to try again.</p>
	</section>
{/if}

<div class="divider"></div>

{#if data.apps}
	<ConnectedAppList
		page={data.apps}
		apiBase="/api/v1"
		mcpUrl={`${page.url.origin}/mcp`}
		onChanged={() => invalidateAll()}
	/>
{:else}
	<section class="notice" role="alert">
		<h2>We couldn’t load your connected apps</h2>
		<p>Refresh the page to try again.</p>
	</section>
{/if}

<div class="divider"></div>

<section id="limits" class="section anchor" aria-labelledby="limits-heading">
	<h2 id="limits-heading">Limits and usage</h2>
	{#if data.usage}<UsageMeters usage={data.usage} />{/if}
	{#if limits && limitsView}
		<p>
			Lower limits never stop existing links or domains; they block new ones. Higher limits use more
			of your Cloudflare plan; see docs/self-hosting/limits.md.
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
				<button class="button primary" type="submit" disabled={limitsPending}
					>{limitsPending ? 'Saving…' : 'Save limits'}</button
				>
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
				The analytics database uses {megabytes(limitsView.analyticsBytes)}. On Workers Paid, one D1
				database holds up to 10 GB, and the plan includes monthly D1 reads, D1 writes, and Queue
				operations before any usage charge.
			</p>
		{/if}
	{:else}
		<section class="notice" role="alert">
			<h2>We couldn’t load the limits</h2>
			<p>Refresh the page to try again.</p>
		</section>
	{/if}
</section>

<div class="divider"></div>

<div id="export" class="anchor">
	<ExportPanel apiBase="/api/v1" retentionDays={data.usage?.retentionDays ?? null} />
</div>

<div class="divider"></div>

<DeleteAccount
	endpoint="/api/account/delete"
	confirmation={account}
	afterDeletion="This installation closes for good. To use Flared again, deploy a new copy."
	fresh={data.tokens?.freshUntil != null && Date.parse(data.tokens.freshUntil) > Date.now()}
	blocked={null}
	onReauthRequired={() => void askReauth()}
	onDeleted={() => window.location.assign('/')}
/>

<style>
	.reauth {
		padding: 1.25rem;
		border: var(--rule);
		border-radius: var(--radius-md);
	}
	.password-form,
	.limits-form {
		display: grid;
		gap: 1rem;
		max-width: 24rem;
	}
	.anchor {
		scroll-margin-top: 1.5rem;
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
