<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import { onMount } from 'svelte';
	import { maxPasskeyNameLength, type PasskeyPage } from '@flared/contracts/passkeys';
	import {
		addPasskey,
		deletePasskey,
		passkeyErrorMessage,
		passkeysSupported,
		renamePasskey,
		type PasskeyResult
	} from './client';

	interface Props {
		page: PasskeyPage;
		// Called after a change succeeds, so the app reloads the list.
		onChanged: () => void | Promise<void>;
		// Called when an add or delete needs a recent sign-in. The edition asks for its own proof.
		onReauthRequired: () => void;
	}

	let { page, onChanged, onReauthRequired }: Props = $props();
	let supported = $state(true);
	let pending = $state<string | null>(null);
	let status = $state('');
	let error = $state('');
	let newName = $state('');
	let renamingId = $state<string | null>(null);
	let renameValue = $state('');
	let confirmingId = $state<string | null>(null);

	const dates = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
	const fresh = () => page.freshUntil !== null && Date.parse(page.freshUntil) > Date.now();

	onMount(() => {
		supported = passkeysSupported();
	});

	async function run(action: string, operation: () => Promise<PasskeyResult>, done: string) {
		pending = action;
		error = '';
		status = '';
		const result = await operation();
		pending = null;
		if (result.ok) {
			status = done;
			await onChanged();
			return true;
		}
		if (result.code === 'REAUTH_REQUIRED') onReauthRequired();
		error = passkeyErrorMessage(result.code);
		return false;
	}

	async function add() {
		if (!fresh()) return onReauthRequired();
		const name = newName.trim() || 'Passkey';
		if (await run('add', () => addPasskey(name), `Added ${name}.`)) newName = '';
	}

	async function rename(id: string) {
		const name = renameValue.trim();
		if (await run(`rename:${id}`, () => renamePasskey(id, name), `Renamed to ${name}.`))
			renamingId = null;
	}

	async function remove(id: string) {
		if (!fresh()) {
			confirmingId = null;
			return onReauthRequired();
		}
		if (await run(`delete:${id}`, () => deletePasskey(id), 'Passkey deleted.')) confirmingId = null;
	}
</script>

<section class="passkeys" aria-labelledby="passkeys-heading">
	<h2 id="passkeys-heading">Passkeys</h2>
	<p class="lead">
		Sign in with your fingerprint, face, or device PIN instead of an emailed code. Email sign-in
		stays available.
	</p>
	<p class="status" role="status" aria-live="polite">{status}</p>
	{#if error}<p class="error" role="alert">{error}</p>{/if}

	{#if page.passkeys.length === 0}
		<p class="empty">No passkeys yet.</p>
	{:else}
		<ul>
			{#each page.passkeys as passkey (passkey.id)}
				{@const label = passkey.name ?? 'Passkey'}
				<li>
					{#if renamingId === passkey.id}
						<form
							class="rename"
							onsubmit={(event) => {
								event.preventDefault();
								void rename(passkey.id);
							}}
						>
							<label for={`rename-${passkey.id}`}>New name for {label}</label>
							<input
								id={`rename-${passkey.id}`}
								bind:value={renameValue}
								maxlength={maxPasskeyNameLength}
								required
							/>
							<button type="submit" disabled={pending !== null}>Save</button>
							<button type="button" class="quiet" onclick={() => (renamingId = null)}>Cancel</button
							>
						</form>
					{:else}
						<div class="main">
							<span class="name">{label}</span>
							<span class="meta">
								{#if passkey.createdAt}Added <time datetime={passkey.createdAt}
										>{dates.format(new Date(passkey.createdAt))}</time
									>{/if}
								{#if passkey.backedUp}<span class="badge">Synced</span>{/if}
							</span>
						</div>
						<div class="actions">
							{#if confirmingId === passkey.id}
								<span class="confirm">Delete {label}?</span>
								<button
									type="button"
									class="danger"
									disabled={pending !== null}
									onclick={() => void remove(passkey.id)}>Delete</button
								>
								<button type="button" class="quiet" onclick={() => (confirmingId = null)}
									>Keep</button
								>
							{:else}
								<button
									type="button"
									class="quiet"
									disabled={pending !== null}
									aria-label={`Rename ${label}`}
									onclick={() => {
										renamingId = passkey.id;
										renameValue = passkey.name ?? '';
										confirmingId = null;
									}}>Rename</button
								>
								<button
									type="button"
									class="quiet"
									disabled={pending !== null}
									aria-label={`Delete ${label}`}
									onclick={() => {
										confirmingId = passkey.id;
										renamingId = null;
									}}>Delete</button
								>
							{/if}
						</div>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}

	{#if supported}
		<form
			class="add"
			onsubmit={(event) => {
				event.preventDefault();
				void add();
			}}
		>
			<label for="passkey-name">Name <span class="optional">optional</span></label>
			<input
				id="passkey-name"
				bind:value={newName}
				maxlength={maxPasskeyNameLength}
				placeholder="Work laptop"
				autocomplete="off"
			/>
			<button type="submit" disabled={pending !== null}
				>{pending === 'add' ? 'Waiting for your device…' : 'Add a passkey'}</button
			>
		</form>
	{:else}
		<p class="empty">This browser cannot use passkeys. Open this page in a current browser.</p>
	{/if}
</section>

<style>
	.passkeys {
		display: grid;
		gap: 0.75rem;
		max-width: 44rem;
	}
	h2 {
		font-size: 1.05rem;
	}
	.lead,
	.status,
	.empty,
	.meta,
	.optional {
		color: var(--color-muted, #667085);
		font-size: 0.85rem;
	}
	.status:empty {
		display: none;
	}
	.error {
		color: var(--color-danger, #b42318);
		font-size: 0.85rem;
	}
	ul {
		display: grid;
		margin: 0;
		padding: 0;
		list-style: none;
		border: 1px solid var(--color-rule, #d0d5dd);
		border-radius: var(--radius-md, 8px);
		background: var(--color-paper, #fff);
	}
	li {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		align-items: center;
		gap: 0.75rem;
		padding: 0.85rem 1rem;
	}
	li + li {
		border-top: 1px solid var(--color-rule, #d0d5dd);
	}
	.main {
		display: grid;
		gap: 0.15rem;
		min-width: 0;
	}
	.name {
		color: var(--color-strong, #101828);
		font-weight: 650;
		overflow-wrap: anywhere;
	}
	.meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
	}
	.badge {
		padding: 0.05rem 0.45rem;
		border: 1px solid var(--color-rule, #d0d5dd);
		border-radius: 999px;
		font-size: 0.75rem;
	}
	.actions,
	.rename {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
	}
	.rename {
		width: 100%;
	}
	.rename label {
		width: 100%;
	}
	.rename input {
		flex: 1 1 12rem;
	}
	.confirm {
		color: var(--color-strong, #101828);
		font-size: 0.85rem;
	}
	.add {
		display: grid;
		gap: 0.4rem;
		max-width: 24rem;
	}
	label {
		color: var(--color-strong, #101828);
		font-size: 0.85rem;
		font-weight: 650;
	}
	input {
		width: 100%;
		min-width: 0;
		min-height: 44px;
		padding: 0.6rem 0.8rem;
		color: var(--color-ink, #101828);
		border: 1px solid var(--color-rule, #d0d5dd);
		border-radius: var(--radius-sm, 6px);
		background: var(--color-paper, #fff);
	}
	input:focus-visible {
		border-color: var(--color-muted, #667085);
		outline: 1px solid var(--color-muted, #667085);
		outline-offset: -1px;
	}
	button {
		min-height: 44px;
		padding: 0.65rem 1.15rem;
		border: 1px solid var(--color-button-primary, #101828);
		border-radius: var(--radius-sm, 6px);
		background: var(--color-button-primary, #101828);
		color: var(--color-on-primary, #fff);
		font-weight: 620;
	}
	button:hover:not(:disabled) {
		background: var(--color-button-primary-hover, #344054);
		border-color: var(--color-button-primary-hover, #344054);
	}
	.add button {
		justify-self: start;
	}
	button.quiet {
		min-height: 40px;
		padding: 0.4rem 0.8rem;
		border-color: var(--color-rule, #d0d5dd);
		background: var(--color-paper, #fff);
		color: var(--color-ink, #101828);
		font-size: 0.8rem;
		font-weight: 600;
	}
	button.quiet:hover:not(:disabled) {
		border-color: var(--color-muted, #667085);
		background: var(--color-paper, #fff);
	}
	button.danger,
	button.danger:hover:not(:disabled) {
		min-height: 40px;
		padding: 0.4rem 0.8rem;
		border-color: var(--color-button-danger, #b42318);
		background: var(--color-button-danger, #b42318);
		font-size: 0.8rem;
	}
	button:disabled {
		color: var(--color-muted, #667085);
		background: var(--color-disabled, #eaecf0);
		border-color: var(--color-disabled, #eaecf0);
	}
</style>
