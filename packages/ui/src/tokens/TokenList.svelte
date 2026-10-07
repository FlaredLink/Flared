<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import {
		defaultTokenExpiryDays,
		maxTokenNameLength,
		maxTokensPerUser,
		scopePresets,
		tokenScopes,
		type ApiTokenPage,
		type CreatedApiToken,
		type TokenExpiryDays,
		type TokenScope
	} from '@flared/contracts/tokens';
	import { createApiToken, revokeApiToken, tokenErrorMessage } from './client';

	interface Props {
		page: ApiTokenPage;
		// The path of the /v1 API for this browser, such as "/api/v1".
		apiBase: string;
		// Called after a change succeeds, so the app reloads the list.
		onChanged: () => void | Promise<void>;
		// Called when creation needs a recent sign-in. The edition asks for its own proof.
		onReauthRequired: () => void;
	}

	let { page, apiBase, onChanged, onReauthRequired }: Props = $props();

	const scopeLabels: Record<TokenScope, string> = {
		'links:read': 'Read links',
		'links:write': 'Create and edit links',
		'analytics:read': 'Read analytics',
		'domains:read': 'Read domains',
		'domains:write': 'Add and remove domains',
		'usage:read': 'Read usage'
	};
	const expiryChoices: { days: TokenExpiryDays; label: string }[] = [
		{ days: 30, label: '30 days' },
		{ days: 90, label: '90 days' },
		{ days: 365, label: '1 year' },
		{ days: null, label: 'No expiry' }
	];

	let name = $state('');
	let scopes = $state<TokenScope[]>([...scopePresets.full]);
	let expiry = $state(String(defaultTokenExpiryDays));
	let pending = $state<string | null>(null);
	let status = $state('');
	let error = $state('');
	let created = $state<CreatedApiToken | null>(null);
	let confirmingId = $state<string | null>(null);

	const dates = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
	const fresh = () => page.freshUntil !== null && Date.parse(page.freshUntil) > Date.now();
	const full = $derived(page.tokens.length >= maxTokensPerUser);
	const sameScopes = (preset: readonly TokenScope[]) =>
		preset.length === scopes.length && preset.every((scope) => scopes.includes(scope));

	function toggle(scope: TokenScope, checked: boolean) {
		scopes = tokenScopes.filter((item) => (item === scope ? checked : scopes.includes(item)));
	}

	async function create() {
		if (!fresh()) {
			error = tokenErrorMessage('REAUTH_REQUIRED');
			return onReauthRequired();
		}
		pending = 'create';
		error = '';
		status = '';
		const result = await createApiToken(apiBase, {
			name: name.trim(),
			scopes,
			expiresInDays:
				expiryChoices.find((choice) => String(choice.days) === expiry)?.days ??
				defaultTokenExpiryDays
		});
		pending = null;
		if (!result.ok) {
			if (result.code === 'REAUTH_REQUIRED') onReauthRequired();
			error = tokenErrorMessage(result.code);
			return;
		}
		created = result.value;
		name = '';
		await onChanged();
	}

	async function copy() {
		if (!created) return;
		try {
			await navigator.clipboard.writeText(created.secret);
			status = 'Token copied.';
		} catch {
			status = 'Select the token and copy it.';
		}
	}

	async function revoke(id: string, label: string) {
		pending = `revoke:${id}`;
		error = '';
		status = '';
		const result = await revokeApiToken(apiBase, id);
		pending = null;
		confirmingId = null;
		if (!result.ok && result.code !== 'NOT_FOUND') {
			error = tokenErrorMessage(result.code);
			return;
		}
		status = `Revoked ${label}.`;
		await onChanged();
	}
</script>

<section class="tokens" aria-labelledby="tokens-heading">
	<h2 id="tokens-heading">API tokens</h2>
	<p class="lead">
		Use a token with the Flared CLI or the API. A token works only in this workspace and only for
		the scopes you choose.
	</p>
	<p class="status" role="status" aria-live="polite">{status}</p>
	{#if error}<p class="error" role="alert">{error}</p>{/if}

	{#if created}
		<div class="reveal" role="region" aria-labelledby="token-reveal-heading">
			<h3 id="token-reveal-heading">Copy {created.token.name} now</h3>
			<p>You will not see this token again. Store it in a password manager or secret store.</p>
			<div class="secret">
				<label class="visually-hidden" for="token-secret">New token</label>
				<input
					id="token-secret"
					readonly
					value={created.secret}
					spellcheck="false"
					onfocus={(event) => event.currentTarget.select()}
				/>
				<button type="button" onclick={() => void copy()}>Copy</button>
			</div>
			<button type="button" class="quiet" onclick={() => (created = null)}>Done</button>
		</div>
	{/if}

	{#if page.tokens.length === 0}
		<p class="empty">No tokens yet.</p>
	{:else}
		<ul>
			{#each page.tokens as token (token.id)}
				<li>
					<div class="main">
						<span class="name">{token.name}</span>
						<code class="start">{token.start}…</code>
						<span class="meta">{token.scopes.map((scope) => scopeLabels[scope]).join(', ')}</span>
						<span class="meta">
							Created <time datetime={token.createdAt}
								>{dates.format(new Date(token.createdAt))}</time
							>
							·
							{#if token.lastUsedAt}Last used <time datetime={token.lastUsedAt}
									>{dates.format(new Date(token.lastUsedAt))}</time
								>{:else}Never used{/if}
							·
							{#if token.expiresAt}Expires <time datetime={token.expiresAt}
									>{dates.format(new Date(token.expiresAt))}</time
								>{:else}No expiry{/if}
						</span>
					</div>
					<div class="actions">
						{#if confirmingId === token.id}
							<span class="confirm">Revoke {token.name}?</span>
							<button
								type="button"
								class="danger"
								disabled={pending !== null}
								onclick={() => void revoke(token.id, token.name)}>Revoke</button
							>
							<button type="button" class="quiet" onclick={() => (confirmingId = null)}>Keep</button
							>
						{:else}
							<button
								type="button"
								class="quiet"
								disabled={pending !== null}
								aria-label={`Revoke ${token.name}`}
								onclick={() => (confirmingId = token.id)}>Revoke</button
							>
						{/if}
					</div>
				</li>
			{/each}
		</ul>
	{/if}

	{#if full}
		<p class="empty">You have {maxTokensPerUser} tokens. Revoke one before you create another.</p>
	{:else}
		<form
			class="create"
			onsubmit={(event) => {
				event.preventDefault();
				void create();
			}}
		>
			<h3>Create a token</h3>
			<div class="field">
				<label for="token-name">Name</label>
				<input
					id="token-name"
					bind:value={name}
					maxlength={maxTokenNameLength}
					placeholder="CI deploys"
					autocomplete="off"
					required
				/>
			</div>
			<fieldset>
				<legend>Scopes</legend>
				<div class="presets">
					<button
						type="button"
						class="quiet"
						aria-pressed={sameScopes(scopePresets.full)}
						onclick={() => (scopes = [...scopePresets.full])}>Full access</button
					>
					<button
						type="button"
						class="quiet"
						aria-pressed={sameScopes(scopePresets.read)}
						onclick={() => (scopes = [...scopePresets.read])}>Read only</button
					>
				</div>
				{#each tokenScopes as scope (scope)}
					<label class="check">
						<input
							type="checkbox"
							checked={scopes.includes(scope)}
							onchange={(event) => toggle(scope, event.currentTarget.checked)}
						/>
						{scopeLabels[scope]} <code>{scope}</code>
					</label>
				{/each}
			</fieldset>
			<div class="field">
				<label for="token-expiry">Expires after</label>
				<select id="token-expiry" bind:value={expiry}>
					{#each expiryChoices as choice (choice.label)}
						<option value={String(choice.days)}>{choice.label}</option>
					{/each}
				</select>
			</div>
			<button type="submit" disabled={pending !== null || scopes.length === 0}
				>{pending === 'create' ? 'Creating…' : 'Create token'}</button
			>
		</form>
	{/if}
</section>

<style>
	.tokens {
		display: grid;
		gap: 0.75rem;
		max-width: 44rem;
	}
	h2 {
		font-size: 1.05rem;
	}
	h3 {
		font-size: 0.95rem;
	}
	.lead,
	.status,
	.empty,
	.meta {
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
	.reveal {
		display: grid;
		gap: 0.6rem;
		padding: 1rem;
		border: 1px solid var(--color-strong, #101828);
		border-radius: var(--radius-md, 8px);
		background: var(--color-surface, #f9fafb);
	}
	.reveal p {
		font-size: 0.85rem;
	}
	.reveal > button {
		justify-self: start;
	}
	.secret {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}
	.secret input {
		flex: 1 1 16rem;
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 0.8rem;
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
	code {
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 0.8rem;
	}
	.start {
		color: var(--color-ink, #101828);
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
	}
	.confirm {
		color: var(--color-strong, #101828);
		font-size: 0.85rem;
	}
	.create {
		display: grid;
		gap: 0.75rem;
		max-width: 28rem;
		margin-top: 0.5rem;
	}
	.field {
		display: grid;
		gap: 0.4rem;
	}
	fieldset {
		display: grid;
		gap: 0.4rem;
		margin: 0;
		padding: 0;
		border: 0;
	}
	legend,
	.field > label {
		margin-bottom: 0.2rem;
		color: var(--color-strong, #101828);
		font-size: 0.85rem;
		font-weight: 650;
	}
	.presets {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin-bottom: 0.25rem;
	}
	.check {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-height: 32px;
		color: var(--color-ink, #101828);
		font-size: 0.85rem;
	}
	.check code {
		color: var(--color-muted, #667085);
	}
	.check input {
		width: 1.1rem;
		height: 1.1rem;
		accent-color: var(--color-button-primary, #101828);
	}
	input:not([type='checkbox']),
	select {
		width: 100%;
		min-width: 0;
		min-height: 44px;
		padding: 0.6rem 0.8rem;
		color: var(--color-ink, #101828);
		border: 1px solid var(--color-rule, #d0d5dd);
		border-radius: var(--radius-sm, 6px);
		background: var(--color-paper, #fff);
	}
	input:focus-visible,
	select:focus-visible {
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
	.create > button {
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
	button.quiet[aria-pressed='true'] {
		border-color: var(--color-strong, #101828);
		box-shadow: inset 0 0 0 1px var(--color-strong, #101828);
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
	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: nowrap;
	}
</style>
