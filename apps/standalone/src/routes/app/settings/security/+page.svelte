<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import Button from '@flared/ui/atoms/Button.svelte';
	import { invalidateAll } from '$app/navigation';
	import PasskeyList from '@flared/ui/passkeys/PasskeyList.svelte';
	import SectionHeader from '@flared/ui/molecules/SectionHeader.svelte';
	import { authErrorMessage, postJson } from '$lib/auth-client';
	import { useSettings } from '$lib/settings';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const settings = useSettings();
	const owner = $derived(data.workspace?.role === 'owner');

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
			if (result.code === 'REAUTH_REQUIRED') return settings.askReauth();
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
</script>

<section class="section" aria-labelledby="password-heading">
	<h2 id="password-heading">Password</h2>
	<p>
		Changing your password ends every other session. {owner
			? 'Without email, a forgotten password is reset from the Cloudflare account.'
			: 'If you forget it, ask the workspace owner for a password reset link.'}
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
		<Button variant="primary" type="submit" disabled={passwordPending}
			>{passwordPending ? 'Changing…' : 'Change password'}</Button
		>
	</form>
</section>

<SectionHeader title="Passkeys" />
{#if data.passkeys}
	<PasskeyList
		page={data.passkeys}
		onChanged={() => invalidateAll()}
		onReauthRequired={settings.askReauth}
	/>
{:else}
	<section class="notice" role="alert">
		<h2>We couldn’t load your passkeys</h2>
		<p>Refresh the page to try again.</p>
	</section>
{/if}

<style>
	.password-form {
		display: grid;
		gap: 1rem;
		max-width: 24rem;
	}
</style>
