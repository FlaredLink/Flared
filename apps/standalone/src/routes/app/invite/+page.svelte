<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { isLinkInvitePreview, type LinkInvitePreview } from '@flared/contracts/members';
	import { authErrorMessage, lookupLink, postJson } from '$lib/auth-client';
	import { appRoutes } from '$lib/routes';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const dates = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
	const signedInAs = $derived(
		data.auth.status === 'authenticated' ? data.auth.principal.user.name : null
	);

	// The token is in the fragment, so no server log or Referer header receives it.
	let token = '';
	let preview = $state<LinkInvitePreview | null>(null);
	let loading = $state(true);
	let ended = $state(false);
	let username = $state('');
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
		const result = await lookupLink('/api/auth/invite/lookup', token);
		loading = false;
		if (result.ok && isLinkInvitePreview(result.body)) preview = result.body;
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
		const result = await postJson('/api/auth/invite/accept', {
			token,
			username: username.trim(),
			password
		});
		pending = false;
		if (!result.ok) {
			if (result.code === 'INVITE_NOT_FOUND') {
				preview = null;
				ended = true;
				return;
			}
			error =
				result.code === 'INVALID_REQUEST'
					? 'Use a username of 3 to 30 letters, digits, underscores, or dots, and a password of 12 to 128 characters.'
					: authErrorMessage(result.code);
			return;
		}
		password = '';
		repeat = '';
		await goto(appRoutes.app, { invalidateAll: true });
	}
</script>

<svelte:head><title>Join a workspace · Flared</title></svelte:head>

<section class="card" aria-labelledby="invite-heading">
	<p class="eyebrow">Flared</p>
	{#if loading}
		<h1 id="invite-heading">Join a workspace</h1>
		<p role="status">Opening the invite…</p>
	{:else if ended}
		<h1 id="invite-heading">This invite has ended</h1>
		<p>
			The link was already used, cancelled, or is older than 7 days. Ask the workspace owner for a
			new link.
		</p>
		<p><a href={appRoutes.login}>Sign in</a></p>
	{:else if preview}
		<h1 id="invite-heading">Join {preview.workspaceName}</h1>
		<p>
			Create your account to join. Members create and edit links and see analytics. The invite works
			until {dates.format(new Date(preview.expiresAt))}.
		</p>
		{#if signedInAs}
			<p class="help">
				You are signed in as {signedInAs}. Creating an account signs you in as the new account
				instead.
			</p>
		{/if}
		<form
			onsubmit={(event) => {
				event.preventDefault();
				void submit();
			}}
		>
			<div class="field">
				<label for="username">Username</label>
				<input
					id="username"
					bind:value={username}
					required
					minlength="3"
					maxlength="30"
					pattern={'[A-Za-z0-9_.]{3,30}'}
					autocomplete="username"
					autocapitalize="none"
					spellcheck="false"
					aria-describedby="username-hint"
				/>
				<small id="username-hint">3 to 30 letters, digits, underscores, or dots.</small>
			</div>
			<div class="field">
				<label for="password">Password</label>
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
				<label for="repeat">Password again</label>
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
				>{pending ? 'Creating your account…' : 'Create account and join'}</button
			>
		</form>
	{:else}
		<h1 id="invite-heading">Join a workspace</h1>
		<p class="error" role="alert">{error}</p>
	{/if}
</section>

<style>
	form {
		display: grid;
		gap: 1rem;
	}
	.help {
		font-size: 0.8rem;
	}
</style>
