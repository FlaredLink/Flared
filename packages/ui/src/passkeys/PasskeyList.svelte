<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import { onMount } from 'svelte';
	import { maxPasskeyNameLength, type PasskeyPage } from '@flared/contracts/passkeys';
	import Panel from '../layout/Panel.svelte';
	import Tile from '../layout/Tile.svelte';
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
	// The name field opens from the header button, so the card stays short.
	let adding = $state(false);

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
		if (await run('add', () => addPasskey(name), `Added ${name}.`)) {
			newName = '';
			adding = false;
		}
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

<Panel
	id="passkeys-heading"
	title="Passkeys"
	lead="Sign in with your fingerprint, face, or device PIN instead of an emailed code."
	icon="key"
	tone="accent"
>
	{#snippet actions()}
		{#if supported && !adding}
			<button type="button" disabled={pending !== null} onclick={() => (adding = true)}
				>Add passkey</button
			>
		{/if}
	{/snippet}
	<p class="status" role="status" aria-live="polite">{status}</p>
	{#if error}<p class="error" role="alert">{error}</p>{/if}

	{#if adding}
		<form
			class="add"
			onsubmit={(event) => {
				event.preventDefault();
				void add();
			}}
		>
			<label for="passkey-name">Name <span class="optional">optional</span></label>
			<div class="add-row">
				<!-- svelte-ignore a11y_autofocus -->
				<input
					id="passkey-name"
					bind:value={newName}
					maxlength={maxPasskeyNameLength}
					placeholder="Work laptop"
					autocomplete="off"
					autofocus
				/>
				<button type="submit" disabled={pending !== null}
					>{pending === 'add' ? 'Waiting for your device…' : 'Continue'}</button
				>
				<button
					type="button"
					class="quiet"
					disabled={pending !== null}
					onclick={() => {
						adding = false;
						newName = '';
					}}>Cancel</button
				>
			</div>
		</form>
	{/if}

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
						<Tile icon="laptop" />
						<div class="main">
							<span class="name"
								>{label}{#if passkey.backedUp}<span class="badge">Synced</span>{/if}</span
							>
							{#if passkey.createdAt}<span class="meta"
									>Added <time datetime={passkey.createdAt}
										>{dates.format(new Date(passkey.createdAt))}</time
									></span
								>{/if}
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
									class="quiet remove"
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

	{#if !supported}
		<p class="empty">This browser cannot use passkeys. Open this page in a current browser.</p>
	{/if}
	<p class="note">Email sign-in stays available.</p>
</Panel>

<style>
	.status,
	.empty,
	.meta,
	.note,
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
		border-top: 1px solid var(--color-rule, #eaecf0);
	}
	li {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.75rem 1rem;
		padding: 0.9rem 0;
		border-bottom: 1px solid var(--color-rule, #eaecf0);
	}
	.main {
		display: grid;
		flex: 1 1 12rem;
		gap: 0.15rem;
		min-width: 0;
	}
	.name {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
		color: var(--color-strong, #101828);
		font-weight: 650;
		overflow-wrap: anywhere;
	}
	.badge {
		padding: 0.1rem 0.5rem;
		border-radius: 999px;
		background: var(--color-disabled, #f2f4f7);
		color: var(--color-ink, #344054);
		font-size: 0.75rem;
		font-weight: 550;
	}
	.actions,
	.rename,
	.add-row {
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
	.rename input,
	.add-row input {
		flex: 1 1 12rem;
	}
	.confirm {
		color: var(--color-strong, #101828);
		font-size: 0.85rem;
	}
	.add {
		display: grid;
		gap: 0.4rem;
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
		background: var(--color-input, #fff);
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
	button.quiet.remove {
		color: var(--color-danger, #b42318);
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
