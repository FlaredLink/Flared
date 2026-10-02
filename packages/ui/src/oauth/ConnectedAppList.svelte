<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import { scopeDescriptions, type ConnectedAppPage } from '@flared/contracts/oauth';
	import { revokeConnectedApp } from './client';

	interface Props {
		page: ConnectedAppPage;
		// The path of the /v1 API for this browser, such as "/api/v1".
		apiBase: string;
		// Called after a removal succeeds, so the app reloads the list.
		onChanged: () => void | Promise<void>;
	}

	let { page, apiBase, onChanged }: Props = $props();
	let pending = $state<string | null>(null);
	let confirming = $state<string | null>(null);
	let status = $state('');
	let error = $state('');
	const dates = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

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
	<h2 id="apps-heading">Connected apps</h2>
	<p class="lead">
		AI assistants and other apps you approved. Removing an app ends its access at once.
	</p>
	<p class="status" role="status" aria-live="polite">{status}</p>
	{#if error}<p class="error" role="alert">{error}</p>{/if}
	{#if page.apps.length === 0}
		<p class="empty">No connected apps.</p>
	{:else}
		<ul>
			{#each page.apps as app (app.clientId)}
				<li>
					<div class="main">
						<span class="name">{app.name}</span>
						{#if app.uri}<span class="meta">{app.uri}</span>{/if}
						<span class="meta"
							>{app.scopes.map((scope) => scopeDescriptions[scope]).join(', ')}</span
						>
						<span class="meta">
							Connected <time datetime={app.connectedAt}
								>{dates.format(new Date(app.connectedAt))}</time
							>
							·
							{#if app.lastActiveAt}Last active <time datetime={app.lastActiveAt}
									>{dates.format(new Date(app.lastActiveAt))}</time
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
	{/if}
</section>

<style>
	.apps {
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
	.meta {
		color: var(--color-muted, #667085);
		font-size: 0.85rem;
	}
	.status:empty {
		display: none;
	}
	.error {
		color: var(--color-accent-ink, #b42318);
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
		overflow-wrap: anywhere;
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
		border-color: var(--color-accent-ink, #b42318);
		background: var(--color-accent-ink, #b42318);
		color: var(--color-on-primary, #fff);
	}
	button:disabled {
		color: var(--color-muted, #667085);
		background: var(--color-disabled, #eaecf0);
		border-color: var(--color-disabled, #eaecf0);
	}
</style>
