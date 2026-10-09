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
	import Glyph from '../icons/Glyph.svelte';
	import Panel from '../layout/Panel.svelte';
	import Tile from '../layout/Tile.svelte';

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
	const same = (a: readonly TokenScope[], b: readonly TokenScope[]) =>
		a.length === b.length && a.every((scope) => b.includes(scope));
	const sameScopes = (preset: readonly TokenScope[]) => same(preset, scopes);
	// A short name for a token's scopes; the full list is in the row's details.
	const access = (granted: readonly TokenScope[]) =>
		same(granted, scopePresets.full)
			? 'Full access'
			: same(granted, scopePresets.read)
				? 'Read only'
				: `${granted.length} of ${tokenScopes.length} scopes`;
	const expired = (token: { expiresAt: string | null }) =>
		token.expiresAt !== null && Date.parse(token.expiresAt) <= Date.now();

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
	<div class="layout">
		<div class="list">
			<div class="titles">
				<h2 id="tokens-heading">API tokens</h2>
				<p class="lead">
					Use a token with the Flared CLI or the API. A token works only in this workspace and only
					for the scopes you choose.
				</p>
			</div>
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
							<Tile icon="key" tone="blue" />
							<div class="main">
								<span class="name">{token.name}</span>
								<span class="facts">
									{#if expired(token)}<span class="state off">Expired</span>{:else}<span
											class="state on">Active</span
										>{/if}
									<span
										class="badge"
										title={token.scopes.map((scope) => scopeLabels[scope]).join(', ')}
										>{access(token.scopes)}</span
									>
									<span
										>{#if token.expiresAt}{expired(token) ? 'Expired' : 'Expires'}
											<time datetime={token.expiresAt}
												>{dates.format(new Date(token.expiresAt))}</time
											>{:else}No expiry{/if}</span
									>
								</span>
								<span class="meta">
									<code>{token.start}…</code>
									·
									{#if token.lastUsedAt}Last used <time datetime={token.lastUsedAt}
											>{dates.format(new Date(token.lastUsedAt))}</time
										>{:else}Never used{/if}
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
									<button type="button" class="quiet" onclick={() => (confirmingId = null)}
										>Keep</button
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

			<div class="callout">
				<Glyph name="info" size={22} />
				<div>
					<strong>Keep tokens private</strong>
					<p>A new token is shown only once. Store it in a password manager or secret store.</p>
				</div>
			</div>
		</div>

		<Panel
			id="token-create-heading"
			title="Create a token"
			lead="A new API token for this workspace."
		>
			{#if full}
				<p class="empty">
					You have {maxTokensPerUser} tokens. Revoke one before you create another.
				</p>
			{:else}
				<form
					class="create"
					onsubmit={(event) => {
						event.preventDefault();
						void create();
					}}
				>
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
						<legend>Permissions</legend>
						<div class="presets">
							<button
								type="button"
								class="preset"
								aria-pressed={sameScopes(scopePresets.read)}
								onclick={() => (scopes = [...scopePresets.read])}>Read only</button
							>
							<button
								type="button"
								class="preset"
								aria-pressed={sameScopes(scopePresets.full)}
								onclick={() => (scopes = [...scopePresets.full])}>Full access</button
							>
						</div>
						<details open={!sameScopes(scopePresets.read) && !sameScopes(scopePresets.full)}>
							<summary>Customize permissions</summary>
							<div class="checks">
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
							</div>
						</details>
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
					<p class="hint">Applies only to this workspace.</p>
				</form>
			{/if}
		</Panel>
	</div>
</section>

<style>
	.tokens {
		container-type: inline-size;
	}
	.layout {
		display: grid;
		gap: 1.5rem;
		align-items: start;
	}
	/* The create panel moves beside the list once both have room. */
	@container (min-width: 50rem) {
		.layout {
			grid-template-columns: minmax(0, 1.5fr) minmax(17rem, 1fr);
		}
	}
	.list {
		display: grid;
		gap: 0.75rem;
		min-width: 0;
	}
	.titles {
		display: grid;
		gap: 0.2rem;
	}
	h2 {
		color: var(--color-strong, #101828);
		font-size: 1.1rem;
	}
	h3 {
		font-size: 0.95rem;
	}
	.lead,
	.status,
	.empty,
	.meta,
	.hint {
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
		padding: 0 1.25rem;
		list-style: none;
		border: 1px solid var(--color-rule, #eaecf0);
		border-radius: var(--radius-lg, 12px);
		background: var(--color-surface, #fff);
	}
	li {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.75rem 1rem;
		padding: 1rem 0;
	}
	li + li {
		border-top: 1px solid var(--color-rule, #eaecf0);
	}
	.main {
		display: grid;
		flex: 1 1 14rem;
		gap: 0.3rem;
		min-width: 0;
	}
	.name {
		color: var(--color-strong, #101828);
		font-weight: 650;
		overflow-wrap: anywhere;
	}
	.facts {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.35rem 0.75rem;
		color: var(--color-muted, #667085);
		font-size: 0.85rem;
	}
	.state {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
	}
	.state::before {
		width: 0.5rem;
		height: 0.5rem;
		border-radius: 50%;
		background: currentColor;
		content: '';
	}
	.state.on {
		color: var(--color-positive, #067647);
	}
	.state.off {
		color: var(--color-danger, #b42318);
	}
	.badge {
		padding: 0.1rem 0.55rem;
		border-radius: 999px;
		background: var(--color-disabled, #f2f4f7);
		color: var(--color-ink, #344054);
		font-size: 0.78rem;
		font-weight: 550;
	}
	code {
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 0.8rem;
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
	.callout {
		display: flex;
		gap: 0.85rem;
		padding: 1rem 1.25rem;
		border: 1px solid var(--color-tile-blue-soft, #d1e9ff);
		border-radius: var(--radius-lg, 12px);
		background: var(--color-tile-blue-soft, #eff8ff);
		color: var(--color-tile-blue, #175cd3);
	}
	.callout :global(svg) {
		flex: none;
	}
	.callout strong {
		color: var(--color-strong, #101828);
		font-size: 0.9rem;
	}
	.callout p {
		color: var(--color-ink, #344054);
		font-size: 0.85rem;
	}
	.create {
		display: grid;
		gap: 1rem;
	}
	.field {
		display: grid;
		gap: 0.4rem;
	}
	fieldset {
		display: grid;
		gap: 0.5rem;
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
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.5rem;
	}
	summary {
		min-height: 32px;
		padding: 0.35rem 0;
		color: var(--color-ink, #101828);
		font-size: 0.85rem;
		font-weight: 550;
		cursor: pointer;
	}
	.checks {
		display: grid;
		gap: 0.2rem;
		padding-top: 0.25rem;
	}
	.check {
		display: flex;
		flex-wrap: wrap;
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
		background: var(--color-input, #fff);
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
	button.quiet,
	button.preset {
		min-height: 40px;
		padding: 0.4rem 0.8rem;
		border-color: var(--color-rule, #d0d5dd);
		background: var(--color-paper, #fff);
		color: var(--color-ink, #101828);
		font-size: 0.8rem;
		font-weight: 600;
	}
	button.preset {
		min-height: 44px;
		font-size: 0.875rem;
	}
	button.quiet:hover:not(:disabled),
	button.preset:hover:not(:disabled) {
		border-color: var(--color-muted, #667085);
		background: var(--color-paper, #fff);
	}
	/* The chosen preset uses the accent tint; the text says which one it is. */
	button.preset[aria-pressed='true'],
	button.preset[aria-pressed='true']:hover:not(:disabled) {
		border-color: var(--color-accent-edge, #f9dbaf);
		background: var(--color-accent-soft, #fff4ed);
		color: var(--color-accent-ink, #b93815);
		box-shadow: inset 0 0 0 1px var(--color-accent-edge, #f9dbaf);
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
