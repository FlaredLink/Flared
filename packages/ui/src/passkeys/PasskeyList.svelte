<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import { onMount } from 'svelte';
	import { maxPasskeyNameLength, type PasskeyPage } from '@flared/contracts/passkeys';
	import SettingRow from '../molecules/SettingRow.svelte';
	import Button from '../atoms/Button.svelte';
	import Badge from '../atoms/Badge.svelte';
	import Glyph from '../icons/Glyph.svelte';
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

<section class="passkeys" aria-labelledby="passkeys-heading">
	<SettingRow
		icon="key"
		id="passkeys-heading"
		title="Passkeys"
		description="Sign in with your fingerprint, face, or device PIN."
	>
		<div class="summary">
			<p class="count">
				{page.passkeys.length === 0
					? 'None added'
					: `${page.passkeys.length} ${page.passkeys.length === 1 ? 'passkey' : 'passkeys'}`}
			</p>
			<p class="note">Email sign-in stays available.</p>
		</div>
		{#if supported && !adding}
			<Button variant="primary" disabled={pending !== null} onclick={() => (adding = true)}
				>Add passkey</Button
			>
		{/if}
	</SettingRow>
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
				<Button type="submit" variant="primary" disabled={pending !== null}
					>{pending === 'add' ? 'Waiting for your device…' : 'Continue'}</Button
				>
				<Button
					variant="ghost"
					disabled={pending !== null}
					onclick={() => {
						adding = false;
						newName = '';
					}}>Cancel</Button
				>
			</div>
		</form>
	{/if}

	{#if page.passkeys.length > 0}
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
							<Button type="submit" size="sm" variant="primary" disabled={pending !== null}
								>Save</Button
							>
							<Button size="sm" variant="ghost" onclick={() => (renamingId = null)}>Cancel</Button>
						</form>
					{:else}
						<span class="device"><Glyph name="laptop" size={22} /></span>
						<div class="main">
							<span class="name"
								>{label}{#if passkey.backedUp}<Badge>Synced</Badge>{/if}</span
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
								<Button
									size="sm"
									variant="danger"
									disabled={pending !== null}
									onclick={() => void remove(passkey.id)}>Delete</Button
								>
								<Button size="sm" variant="ghost" onclick={() => (confirmingId = null)}>Keep</Button
								>
							{:else}
								<Button
									size="sm"
									variant="ghost"
									disabled={pending !== null}
									aria-label={`Rename ${label}`}
									onclick={() => {
										renamingId = passkey.id;
										renameValue = passkey.name ?? '';
										confirmingId = null;
									}}>Rename</Button
								>
								<Button
									size="sm"
									variant="danger-soft"
									disabled={pending !== null}
									aria-label={`Delete ${label}`}
									onclick={() => {
										confirmingId = passkey.id;
										renamingId = null;
									}}>Delete…</Button
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
</section>

<style>
	.passkeys {
		display: grid;
		gap: 0.5rem;
	}
	.summary {
		display: grid;
		flex: 1;
		gap: 0.15rem;
	}
	.count {
		color: var(--color-strong);
		font-size: 0.9375rem;
	}
	.note,
	.status,
	.empty,
	.meta,
	.optional {
		color: var(--color-lead);
		font-size: 0.875rem;
	}
	.status:empty {
		display: none;
	}
	.error {
		color: var(--color-danger);
		font-size: 0.875rem;
	}
	.add {
		display: grid;
		gap: 0.4rem;
		margin-left: 3.25rem;
		padding: 0.5rem 0 1rem;
		border-bottom: 1px solid var(--color-rule);
	}
	.add label,
	.rename label {
		color: var(--color-strong);
		font-size: 0.9375rem;
		font-weight: 600;
	}
	.optional {
		font-weight: 400;
	}
	.add-row,
	.rename {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
	}
	.rename {
		flex: 1;
	}
	.rename label {
		flex-basis: 100%;
	}
	input {
		flex: 1 1 14rem;
		min-width: 0;
		min-height: 2.75rem;
		padding: 0 0.9rem;
		border: 1px solid var(--color-rule);
		border-radius: var(--radius-control, 0.5rem);
		background: var(--color-input);
		color: var(--color-strong);
		font: inherit;
		font-size: 0.9375rem;
	}
	input:focus {
		border-color: var(--color-strong);
		outline: 1px solid var(--color-strong);
		outline-offset: -1px;
	}
	ul {
		display: grid;
		margin: 0 0 0 3.25rem;
		padding: 0;
		list-style: none;
	}
	li {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem 0.9rem;
		padding: 0.85rem 0;
		border-bottom: 1px solid var(--color-rule);
	}
	.device {
		display: grid;
		color: var(--color-lead);
	}
	.main {
		display: grid;
		flex: 1 1 12rem;
		gap: 0.1rem;
		min-width: 0;
	}
	.name {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		color: var(--color-strong);
		font-weight: 600;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
	}
	.confirm {
		color: var(--color-strong);
		font-size: 0.9375rem;
	}
	@media (max-width: 40rem) {
		.add,
		ul {
			margin-left: 0;
		}
	}
</style>
