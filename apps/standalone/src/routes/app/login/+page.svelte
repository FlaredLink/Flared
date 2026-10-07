<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import {
		passkeyAutofillSupported,
		passkeyErrorMessage,
		passkeysSupported,
		signInWithPasskey
	} from '@flared/ui/passkeys/client';
	import { nextFromSearch, pendingAuthorization } from '@flared/ui/navigation';
	import { authErrorMessage, postJson } from '$lib/auth-client';
	import { appRoutes } from '$lib/routes';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	let username = $state('');
	let password = $state('');
	let pending = $state(false);
	let error = $state('');
	let passkeys = $state(false);

	// After sign-in, continue an app's authorization request, or open the requested app page.
	async function signedIn() {
		const resume = pendingAuthorization(window.location.search);
		if (resume) return window.location.assign(resume);
		// A move to a new address reloads every page from the new app state.
		if (data.moving) return window.location.assign(appRoutes.app);
		await goto(nextFromSearch(window.location.search) ?? appRoutes.app, { invalidateAll: true });
	}

	async function submit() {
		pending = true;
		error = '';
		const result = await postJson('/api/auth/sign-in/password', {
			username: username.trim(),
			password
		});
		pending = false;
		if (!result.ok) {
			error = authErrorMessage(result.code);
			return;
		}
		password = '';
		await signedIn();
	}

	async function usePasskey(autofill: boolean) {
		if (!autofill) {
			pending = true;
			error = '';
		}
		const result = await signInWithPasskey(autofill);
		if (!autofill) pending = false;
		if (result.ok) return signedIn();
		// A closed prompt is a choice, and autofill stays quiet until someone picks a passkey.
		if (result.code === 'CANCELLED' || (autofill && result.code !== 'PASSKEY_REJECTED')) return;
		error = passkeyErrorMessage(result.code);
	}

	onMount(() => {
		passkeys = passkeysSupported() && !data.moving;
		if (data.unavailable || data.moving) return;
		void passkeyAutofillSupported().then((supported) => {
			if (supported) void usePasskey(true);
		});
	});
</script>

<svelte:head><title>Sign in · Flared</title></svelte:head>

<section class="card" aria-labelledby="login-heading">
	<p class="eyebrow">Flared</p>
	<h1 id="login-heading">Sign in</h1>
	{#if data.moving}
		<p>
			This installation moved to this address. Sign in with your password to finish the move.
			Sessions, connected apps, and passkeys of the old address end.
		</p>
	{:else if data.connecting}
		<p>Sign in to connect the app to your workspace.</p>
	{/if}
	{#if data.unavailable}
		<p class="error" role="alert">We couldn’t check your session. Refresh the page to try again.</p>
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
				autocomplete="username webauthn"
				autocapitalize="none"
				spellcheck="false"
			/>
		</div>
		<div class="field">
			<label for="password">Password</label>
			<input
				id="password"
				type="password"
				bind:value={password}
				required
				autocomplete="current-password"
			/>
		</div>
		{#if error}<p class="error" role="alert">{error}</p>{/if}
		<button class="button primary wide" type="submit" disabled={pending}
			>{pending ? 'Signing in…' : 'Sign in'}</button
		>
	</form>
	{#if passkeys}
		<button
			class="button secondary wide"
			type="button"
			disabled={pending}
			onclick={() => void usePasskey(false)}>Sign in with a passkey</button
		>
	{/if}
	<p class="help">
		Forgot your password? The operator resets it with <code>bun run owner:reset-password</code>
		in the deployed copy; see docs/self-hosting/recovery.md.
	</p>
</section>

<style>
	form {
		display: grid;
		gap: 1rem;
	}
	.help {
		font-size: 0.8rem;
	}
	code {
		font-family: var(--font-mono);
		font-size: 0.85em;
	}
</style>
