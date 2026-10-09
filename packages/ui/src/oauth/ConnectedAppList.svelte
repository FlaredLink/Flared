<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import { scopeDescriptions, type ConnectedAppPage } from '@flared/contracts/oauth';
	import { revokeConnectedApp } from './client';
	import AssistantMark from './AssistantMark.svelte';
	import ConnectGuide from './ConnectGuide.svelte';

	interface Props {
		page: ConnectedAppPage;
		// The path of the /v1 API for this browser, such as "/api/v1".
		apiBase: string;
		// The MCP endpoint that the setup steps show.
		mcpUrl: string;
		// Called after a removal succeeds, so the app reloads the list.
		onChanged: () => void | Promise<void>;
	}

	let { page, apiBase, mcpUrl, onChanged }: Props = $props();
	let pending = $state<string | null>(null);
	let confirming = $state<string | null>(null);
	let status = $state('');
	let error = $state('');
	const dates = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
	// The descriptions start with a capital; in one list only the first keeps it.
	const sentence = (parts: string[]) =>
		parts
			.map((part, index) => (index === 0 ? part : part[0].toLowerCase() + part.slice(1)))
			.join(', ');

	async function remove(clientId: string, name: string) {
		pending = clientId;
		error = '';
		status = '';
		const result = await revokeConnectedApp(apiBase, clientId);
		pending = null;
		confirming = null;
		if (!result.ok && result.code !== 'NOT_FOUND') {
			error =
				result.code === 'UNAUTHENTICATED'
					? 'Your session ended. Sign in again.'
					: 'Something went wrong. Try again.';
			return;
		}
		status = `Removed ${name}.`;
		await onChanged();
	}
</script>

<section class="apps" aria-labelledby="apps-heading">
	<div class="titles">
		<h2 id="apps-heading">Connected apps</h2>
		<p class="lead">
			Use Flared from the AI assistants you already work in. Removing an app ends its access at
			once.
		</p>
	</div>
	<p class="status" role="status" aria-live="polite">{status}</p>
	{#if error}<p class="error" role="alert">{error}</p>{/if}
	{#if page.apps.length > 0}
		<ul>
			{#each page.apps as app (app.clientId)}
				<li>
					<span class="tile {app.assistant ?? 'other'}" aria-hidden="true"
						>{#if app.assistant}<AssistantMark assistant={app.assistant} size={30} />{:else}{(
								Array.from(app.name)[0] ?? '?'
							).toLocaleUpperCase()}{/if}</span
					>
					<div class="main">
						<span class="name">{app.name}</span>
						<span class="meta">{sentence(app.scopes.map((scope) => scopeDescriptions[scope]))}</span
						>
						<span class="connected">
							Connected <time datetime={app.connectedAt}
								>{dates.format(new Date(app.connectedAt))}</time
							>
						</span>
						<span class="meta">
							{#if app.uri}{app.uri}{' · '}{/if}{#if app.lastActiveAt}Last active <time
									datetime={app.lastActiveAt}>{dates.format(new Date(app.lastActiveAt))}</time
								>{:else}Not used yet{/if}
						</span>
					</div>
					<div class="actions">
						{#if confirming === app.clientId}
							<span class="confirm">Remove {app.name}?</span>
							<button
								type="button"
								class="danger"
								disabled={pending !== null}
								onclick={() => void remove(app.clientId, app.name)}>Remove</button
							>
							<button type="button" onclick={() => (confirming = null)}>Keep</button>
						{:else}
							<button
								type="button"
								disabled={pending !== null}
								aria-label={`Remove ${app.name}`}
								onclick={() => (confirming = app.clientId)}>Remove</button
							>
						{/if}
					</div>
				</li>
			{/each}
		</ul>
		<p class="note">No API token needed.</p>
	{/if}
	<ConnectGuide {mcpUrl} another={page.apps.length > 0} />
</section>

<style>
	.apps {
		display: grid;
		gap: 0.75rem;
		container-type: inline-size;
	}
	.titles {
		display: grid;
		gap: 0.2rem;
	}
	h2 {
		color: var(--color-strong, #101828);
		font-size: 1.1rem;
	}
	.lead,
	.status,
	.meta,
	.note {
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
		gap: 0.75rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	@container (min-width: 44rem) {
		ul {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}
	li {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.75rem 1rem;
		padding: 1.25rem;
		border: 1px solid var(--color-rule, #eaecf0);
		border-radius: var(--radius-lg, 12px);
		background: var(--color-surface, #fff);
	}
	/* An official mark only for a verified assistant; any other app gets its initial. */
	.tile {
		display: grid;
		flex: none;
		place-items: center;
		width: 3.5rem;
		height: 3.5rem;
		border-radius: var(--radius-md, 8px);
		background: var(--color-disabled, #f2f4f7);
		color: var(--color-muted, #667085);
		font-size: 1.2rem;
		font-weight: 700;
	}
	.tile.claude {
		background: var(--color-accent-soft, #fff4ed);
	}
	.main {
		display: grid;
		flex: 1 1 12rem;
		gap: 0.2rem;
		min-width: 0;
	}
	.name {
		color: var(--color-strong, #101828);
		font-size: 1.05rem;
		font-weight: 650;
		overflow-wrap: anywhere;
	}
	.meta {
		overflow-wrap: anywhere;
	}
	.connected {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		color: var(--color-ink, #344054);
		font-size: 0.85rem;
	}
	.connected::before {
		width: 0.5rem;
		height: 0.5rem;
		border-radius: 50%;
		background: var(--color-positive, #067647);
		content: '';
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
	button {
		min-height: 40px;
		padding: 0.4rem 0.8rem;
		border: 1px solid var(--color-rule, #d0d5dd);
		border-radius: var(--radius-sm, 6px);
		background: var(--color-paper, #fff);
		color: var(--color-ink, #101828);
		font-size: 0.8rem;
		font-weight: 600;
	}
	button:hover:not(:disabled) {
		border-color: var(--color-muted, #667085);
	}
	button.danger,
	button.danger:hover:not(:disabled) {
		border-color: var(--color-button-danger, #b42318);
		background: var(--color-button-danger, #b42318);
		color: var(--color-on-primary, #fff);
	}
	button:disabled {
		color: var(--color-muted, #667085);
		background: var(--color-disabled, #eaecf0);
		border-color: var(--color-disabled, #eaecf0);
	}
</style>
