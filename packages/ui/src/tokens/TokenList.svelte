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
	import Button from '../atoms/Button.svelte';
	import Badge from '../atoms/Badge.svelte';
	import Checkbox from '../atoms/Checkbox.svelte';
	import Select from '../atoms/Select.svelte';
	import TextInput from '../atoms/TextInput.svelte';
	import SectionHeader from '../molecules/SectionHeader.svelte';
	import SidePanel from '../molecules/SidePanel.svelte';
	import SplitView from '../molecules/SplitView.svelte';
	import Callout from '../molecules/Callout.svelte';
	import CopyButton from '../molecules/CopyButton.svelte';
	import FormField from '../molecules/FormField.svelte';

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
		'usage:read': 'Read usage and limits'
	};
	const expiryChoices: { days: TokenExpiryDays; label: string }[] = [
		{ days: 30, label: '30 days' },
		{ days: 90, label: '90 days' },
		{ days: 365, label: '1 year' },
		{ days: null, label: 'No expiry' }
	];

	let name = $state('');
	let scopes = $state<TokenScope[]>([...scopePresets.read]);
	let expiry = $state(String(defaultTokenExpiryDays));
	let pending = $state<string | null>(null);
	let status = $state('');
	let error = $state('');
	let created = $state<CreatedApiToken | null>(null);
	let confirmingId = $state<string | null>(null);
	// The create form opens in a side panel from the section's button.
	let creating = $state(false);
	let nameInput = $state<HTMLInputElement>();
	// Opening the panel moves the keyboard into the form.
	$effect(() => {
		if (creating) nameInput?.focus();
	});

	const dates = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
	const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
	// "2 hours ago" or "Yesterday" for recent use; the date after a week.
	function lastUsed(at: string): string {
		const seconds = (Date.parse(at) - Date.now()) / 1000;
		const steps: [Intl.RelativeTimeFormatUnit, number][] = [
			['minute', 60],
			['hour', 3600],
			['day', 86400]
		];
		if (seconds > -60) return 'Just now';
		if (seconds < -7 * 86400) return dates.format(new Date(at));
		const [unit, size] = [...steps].reverse().find(([, step]) => -seconds >= step) ?? steps[0];
		const text = relative.format(Math.round(seconds / size), unit);
		return text.charAt(0).toLocaleUpperCase() + text.slice(1);
	}
	// One sentence that names what the chosen scopes allow.
	const summary = $derived.by(() => {
		if (scopes.length === 0) return 'Choose at least one permission.';
		if (same(scopes, scopePresets.full))
			return 'This token can read and change everything in the workspace.';
		const parts = scopes.map((scope) => scopeLabels[scope].toLocaleLowerCase());
		const list =
			parts.length > 1 ? `${parts.slice(0, -1).join(', ')}, and ${parts.at(-1)}` : parts[0];
		return `This token can ${list}.`;
	});
	const activeCount = $derived(page.tokens.filter((token) => !expired(token)).length);
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
				: granted.length <= 2
					? granted.map((scope) => scopeLabels[scope]).join(', ')
					: `${granted.length} of ${tokenScopes.length} permissions`;
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
		creating = false;
		await onChanged();
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

<!-- The create form opens beside the list; without it the list takes the full width. -->
{#snippet createPanel()}
	<SidePanel id="token-create-label" label="New API token" onclose={() => (creating = false)}>
		<form
			class="create"
			onsubmit={(event) => {
				event.preventDefault();
				void create();
			}}
		>
			<h3>Create a token</h3>
			<FormField for="token-name" label="Name">
				<TextInput
					id="token-name"
					bind:value={name}
					bind:input={nameInput}
					maxlength={maxTokenNameLength}
					placeholder="Release script"
					autocomplete="off"
					required
				/>
			</FormField>
			<fieldset>
				<legend>Permissions</legend>
				<p class="hint">Choose the smallest access needed.</p>
				<div class="presets">
					<button
						type="button"
						aria-pressed={sameScopes(scopePresets.read)}
						onclick={() => (scopes = [...scopePresets.read])}>Read only</button
					>
					<button
						type="button"
						aria-pressed={sameScopes(scopePresets.full)}
						onclick={() => (scopes = [...scopePresets.full])}>Full access</button
					>
				</div>
				<div class="checks">
					{#each tokenScopes as scope (scope)}
						<Checkbox
							checked={scopes.includes(scope)}
							onchange={(event) => toggle(scope, event.currentTarget.checked)}
							>{scopeLabels[scope]}</Checkbox
						>
					{/each}
				</div>
				<p class="hint summary">{summary}</p>
			</fieldset>
			<FormField for="token-expiry" label="Expires after">
				<Select id="token-expiry" bind:value={expiry}>
					{#each expiryChoices as choice (choice.label)}
						<option value={String(choice.days)}>{choice.label}</option>
					{/each}
				</Select>
			</FormField>
			<Callout tone="warning" icon="key">
				<p>The token is shown once. Store it securely after creation.</p>
			</Callout>
			{#if error}<p class="error" role="alert">{error}</p>{/if}
			<div class="buttons">
				<Button
					type="submit"
					variant="primary"
					size="lg"
					wide
					disabled={pending !== null || scopes.length === 0 || full}
					>{pending === 'create' ? 'Creating…' : 'Create token'}</Button
				>
				<Button size="lg" wide onclick={() => (creating = false)}>Cancel</Button>
			</div>
		</form>
	</SidePanel>
{/snippet}

<section class="tokens" aria-labelledby="tokens-heading">
	<SplitView panel={creating ? createPanel : undefined}>
		<div class="list">
			<SectionHeader
				id="tokens-heading"
				title="API tokens"
				lead="Give scripts and services only the access they need."
			>
				{#snippet actions()}
					{#if !creating}
						<Button
							variant="primary"
							icon="plus"
							disabled={full}
							onclick={() => {
								creating = true;
								created = null;
								error = '';
							}}>Create token</Button
						>
					{/if}
				{/snippet}
			</SectionHeader>
			<p class="count">
				{activeCount}
				{activeCount === 1 ? 'active token' : 'active tokens'}{#if full}. You have {maxTokensPerUser}
					tokens; revoke one before you create another.{/if}
			</p>
			<p class="status" role="status" aria-live="polite">{status}</p>
			{#if error && !creating}<p class="error" role="alert">{error}</p>{/if}

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
						<CopyButton text={created.secret} label="Copy token" kind="button" variant="primary" />
					</div>
					<Button variant="ghost" size="sm" onclick={() => (created = null)}>Done</Button>
				</div>
			{/if}

			{#if page.tokens.length === 0}
				<p class="empty">No tokens yet. Create one for the CLI, a script, or a service.</p>
			{:else}
				<div class="table" role="table" aria-labelledby="tokens-heading">
					<div class="head" role="row">
						<span role="columnheader">Name</span>
						<span role="columnheader">Access</span>
						<span role="columnheader">Last used</span>
						<span role="columnheader" class="actions-head">Actions</span>
					</div>
					{#each page.tokens as token (token.id)}
						<div class="row" role="row">
							<div class="name-cell" role="cell">
								<Glyph name="key" size={22} />
								<span class="name-text">
									<span class="name">{token.name}</span>
									<span class="meta"
										>Created {dates.format(new Date(token.createdAt))} ·
										{#if token.expiresAt}{expired(token) ? 'Expired' : 'Expires'}
											<time datetime={token.expiresAt}
												>{dates.format(new Date(token.expiresAt))}</time
											>{:else}No expiry{/if}
									</span>
									<code>{token.start}…</code>
								</span>
							</div>
							<div role="cell" class="access">
								<span title={token.scopes.map((scope) => scopeLabels[scope]).join(', ')}
									>{access(token.scopes)}</span
								>
								{#if expired(token)}<Badge tone="warning">Expired</Badge>{/if}
							</div>
							<div role="cell" class="used">
								{#if token.lastUsedAt}<time datetime={token.lastUsedAt}
										>{lastUsed(token.lastUsedAt)}</time
									>{:else}Never{/if}
							</div>
							<div role="cell" class="actions">
								{#if confirmingId === token.id}
									<span class="confirm">Revoke?</span>
									<Button
										size="sm"
										variant="danger"
										disabled={pending !== null}
										onclick={() => void revoke(token.id, token.name)}>Revoke</Button
									>
									<Button size="sm" variant="ghost" onclick={() => (confirmingId = null)}
										>Keep</Button
									>
								{:else}
									<Button
										size="sm"
										variant="danger-soft"
										disabled={pending !== null}
										aria-label={`Revoke ${token.name}`}
										onclick={() => (confirmingId = token.id)}>Revoke…</Button
									>
								{/if}
							</div>
						</div>
					{/each}
				</div>
			{/if}

			<p class="foot">
				<Glyph name="lock" size={20} />Keep tokens private. Revoking a token stops applications that
				use it.
			</p>
		</div>
	</SplitView>
</section>

<style>
	.list {
		display: grid;
		gap: 1rem;
		min-width: 0;
	}
	.count {
		color: var(--color-strong);
		font-size: 0.9875rem;
	}
	.status,
	.empty,
	.meta,
	.hint {
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
	.reveal {
		display: grid;
		gap: 0.6rem;
		padding: 1rem 1.25rem;
		border: 1px solid color-mix(in oklch, var(--color-positive) 35%, transparent);
		border-radius: var(--radius-md, 0.625rem);
		background: var(--color-positive-soft);
	}
	.reveal h3 {
		color: var(--color-strong);
		font-size: 1rem;
	}
	.reveal p {
		color: var(--color-ink);
		font-size: 0.9375rem;
	}
	.reveal > :global(button:last-child) {
		justify-self: start;
	}
	.secret {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}
	.secret input {
		flex: 1 1 16rem;
		min-width: 0;
		min-height: 2.75rem;
		padding: 0 0.9rem;
		border: 1px solid var(--color-rule);
		border-radius: var(--radius-control, 0.5rem);
		background: var(--color-paper);
		color: var(--color-strong);
		font-family: var(--font-mono);
		font-size: 0.875rem;
	}
	.table {
		border: 1px solid var(--color-rule);
		border-radius: var(--radius-md, 0.625rem);
		background: var(--color-paper);
		overflow: hidden;
		container-type: inline-size;
	}
	.head,
	.row {
		display: grid;
		grid-template-columns: minmax(0, 1.6fr) minmax(0, 1.1fr) minmax(0, 0.9fr) auto;
		align-items: center;
		gap: 1rem;
		padding: 0.85rem 1.1rem;
	}
	.head {
		padding-block: 0.75rem;
		border-bottom: 1px solid var(--color-rule);
		background: var(--color-canvas);
		color: var(--color-lead);
		font-size: 0.8125rem;
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}
	.actions-head {
		min-width: 6.5rem;
	}
	.row + .row {
		border-top: 1px solid var(--color-rule);
	}
	.name-cell {
		display: flex;
		align-items: center;
		gap: 0.85rem;
		min-width: 0;
		color: var(--color-ink);
	}
	.name-text {
		display: grid;
		gap: 0.1rem;
		min-width: 0;
	}
	.name {
		overflow: hidden;
		color: var(--color-strong);
		font-weight: 600;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	code {
		color: var(--color-lead);
		font-size: 0.8125rem;
	}
	.access,
	.used {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.4rem;
		color: var(--color-ink);
		font-size: 0.9375rem;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: flex-start;
		gap: 0.4rem;
		min-width: 6.5rem;
	}
	.confirm {
		color: var(--color-strong);
		font-size: 0.9375rem;
	}
	.foot {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		color: var(--color-lead);
		font-size: 0.875rem;
	}
	.create {
		display: grid;
		gap: 1.1rem;
	}
	.create h3 {
		color: var(--color-strong);
		font-size: 1.75rem;
		font-weight: 750;
		letter-spacing: -0.035em;
		line-height: 1.15;
	}
	fieldset {
		display: grid;
		gap: 0.3rem;
		margin: 0;
		padding: 0;
		border: 0;
	}
	legend {
		padding: 0;
		color: var(--color-strong);
		font-size: 1.0625rem;
		font-weight: 650;
	}
	.presets {
		display: flex;
		gap: 0.5rem;
		margin: 0.4rem 0 0.15rem;
	}
	.presets button {
		min-height: 2rem;
		padding: 0 0.75rem;
		border: 1px solid var(--color-rule);
		border-radius: var(--radius-pill, 999px);
		background: var(--color-paper);
		color: var(--color-ink);
		font: inherit;
		font-size: 0.8125rem;
		cursor: pointer;
	}
	.presets button[aria-pressed='true'] {
		border-color: var(--color-accent);
		background: var(--color-accent-soft);
		color: var(--color-strong);
		font-weight: 600;
	}
	.checks {
		display: grid;
	}
	.summary {
		margin-top: 0.4rem;
	}
	.buttons {
		display: grid;
		gap: 0.6rem;
	}
	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
	/* Narrow tables stack each token: name, then access and use, then the action. */
	@container (max-width: 36rem) {
		.head {
			display: none;
		}
		.row {
			grid-template-columns: minmax(0, 1fr) auto;
			gap: 0.4rem 1rem;
		}
		.name-cell {
			grid-column: 1 / -1;
		}
		.actions {
			grid-column: 2;
			grid-row: 2 / 4;
			justify-content: flex-end;
		}
	}
</style>
