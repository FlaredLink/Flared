<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { isPasswordResetPreview, type PasswordResetPreview } from '@flared/contracts/members';
	import { authErrorMessage, lookupLink, postJson } from '$lib/auth-client';
	import { appRoutes } from '$lib/routes';

	const times = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

	// The token is in the fragment, so no server log or Referer header receives it.
	let token = '';
	let preview = $state<PasswordResetPreview | null>(null);
	let loading = $state(true);
	let ended = $state(false);
	let password = $state('');
	let repeat = $state('');
	let pending = $state(false);
	let error = $state('');

	onMount(async () => {
		token = window.location.hash.slice(1);
		// The token stays in this page only, not in the history.
		history.replaceState(history.state, '', window.location.pathname);
		if (!token) {
			ended = true;
			loading = false;
			return;
		}
		const result = await lookupLink('/api/auth/password/reset/lookup', token);
		loading = false;
		if (result.ok && isPasswordResetPreview(result.body)) preview = result.body;
		else if (!result.ok && result.ended) ended = true;
		else error = authErrorMessage(result.ok ? 'AUTH_UNAVAILABLE' : result.code);
	});

	async function submit() {
		error = '';
		if (password !== repeat) {
			error = 'The passwords do not match.';
			return;
		}
		pending = true;
		const result = await postJson('/api/auth/password/reset', { token, newPassword: password });
		pending = false;
		if (!result.ok) {
			if (result.code === 'RESET_NOT_FOUND') {
				preview = null;
				ended = true;
				return;
			}
			error =
				result.code === 'INVALID_REQUEST'
					? 'Use a password of 12 to 128 characters.'
					: authErrorMessage(result.code);
			return;
		}
		password = '';
		repeat = '';
		await goto(appRoutes.app, { invalidateAll: true });
	}
</script>

<svelte:head><title>Set a new password · Flared</title></svelte:head>

<section class="card" aria-labelledby="reset-heading">
	<p class="eyebrow">Flared</p>
	{#if loading}
		<h1 id="reset-heading">Set a new password</h1>
		<p role="status">Opening the link…</p>
	{:else if ended}
		<h1 id="reset-heading">This link has ended</h1>
		<p>
			The link was already used, replaced by a newer one, or is older than 24 hours. Ask the
			workspace owner for a new link.
		</p>
		<p><a href={appRoutes.login}>Sign in</a></p>
	{:else if preview}
		<h1 id="reset-heading">Set a new password</h1>
		<p>
			For {preview.username} in {preview.workspaceName}. The new password signs you out on every
			device; your API tokens keep working. The link works until
			{times.format(new Date(preview.expiresAt))}.
		</p>
		<form
			onsubmit={(event) => {
				event.preventDefault();
				void submit();
			}}
		>
			<input
				class="visually-hidden"
				type="text"
				value={preview.username}
				autocomplete="username"
				readonly
				tabindex="-1"
				aria-hidden="true"
			/>
			<div class="field">
				<label for="password">New password</label>
				<input
					id="password"
					type="password"
					bind:value={password}
					required
					minlength="12"
					maxlength="128"
					autocomplete="new-password"
					aria-describedby="password-hint"
				/>
				<small id="password-hint">12 to 128 characters.</small>
			</div>
			<div class="field">
				<label for="repeat">New password again</label>
				<input
					id="repeat"
					type="password"
					bind:value={repeat}
					required
					autocomplete="new-password"
				/>
			</div>
			{#if error}<p class="error" role="alert">{error}</p>{/if}
			<button class="button primary wide" type="submit" disabled={pending}
				>{pending ? 'Saving…' : 'Set password and sign in'}</button
			>
		</form>
	{:else}
		<h1 id="reset-heading">Set a new password</h1>
		<p class="error" role="alert">{error}</p>
	{/if}
</section>

<style>
	form {
		display: grid;
		gap: 1rem;
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
