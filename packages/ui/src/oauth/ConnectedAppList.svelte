<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import { onMount, type Snippet } from 'svelte';
	import { scopeDescriptions, type ConnectedAppPage } from '@flared/contracts/oauth';
	import Glyph from '../icons/Glyph.svelte';
	import Button from '../atoms/Button.svelte';
	import SplitView from '../molecules/SplitView.svelte';
	import SidePanel from '../molecules/SidePanel.svelte';
	import Callout from '../molecules/Callout.svelte';
	import { revokeConnectedApp } from './client';
	import AssistantMark from './AssistantMark.svelte';
	import ConnectGuide from './ConnectGuide.svelte';
	import AssistantSetup from './AssistantSetup.svelte';
	import type { AssistantId } from './assistants';

	interface Props {
		page: ConnectedAppPage;
		// The path of the /v1 API for this browser, such as "/api/v1".
		apiBase: string;
		// The MCP endpoint that the setup steps show.
		mcpUrl: string;
		// Called after a removal succeeds, so the app reloads the list.
		onChanged: () => void | Promise<void>;
		// The page header, so the setup panel lines up with it.
		header?: Snippet;
		// Every step for each assistant, such as the edition's docs page.
		guideHref?: string;
	}

	let { page, apiBase, mcpUrl, onChanged, header, guideHref }: Props = $props();
	let pending = $state<string | null>(null);
	let confirming = $state<string | null>(null);
	let status = $state('');
	let error = $state('');
	let selected = $state<AssistantId | null>(null);
	const dates = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
	// The descriptions start with a capital; in one list only the first keeps it.
	const sentence = (parts: string[]) =>
		parts
			.map((part, index) => (index === 0 ? part : part[0].toLowerCase() + part.slice(1)))
			.join(', ');

	// With room for two columns and nothing connected yet, Claude's setup opens, as in the mockups.
	onMount(() => {
		if (page.apps.length === 0 && window.matchMedia('(min-width: 75rem)').matches)
			selected = 'claude';
	});

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

<!-- The panel is passed only while a setup is open, so the lists keep the full width. -->
{#snippet setup()}
	{#if selected}
		<SidePanel id="assistant-setup-label" label="Assistant setup" onclose={() => (selected = null)}>
			<AssistantSetup assistant={selected} {mcpUrl} {guideHref} />
		</SidePanel>
	{/if}
{/snippet}

<SplitView panel={selected ? setup : undefined}>
	{#if header}{@render header()}{/if}
	<div class="connections">
		<section class="apps" aria-labelledby="apps-heading">
			<h2 id="apps-heading">Connected apps ({page.apps.length})</h2>
			<p class="visually-hidden" role="status" aria-live="polite">{status}</p>
			{#if error}<Callout tone="danger" role="alert"><p>{error}</p></Callout>{/if}
			{#if page.apps.length > 0}
				<ul class="app-list">
					{#each page.apps as app (app.clientId)}
						<li>
							<span class="tile" aria-hidden="true"
								>{#if app.assistant}<AssistantMark assistant={app.assistant} size={28} />{:else}{(
										Array.from(app.name)[0] ?? '?'
									).toLocaleUpperCase()}{/if}</span
							>
							<div class="main">
								<span class="name">{app.name}</span>
								<span class="meta"
									>{sentence(app.scopes.map((scope) => scopeDescriptions[scope]))}</span
								>
								<span class="meta">
									Connected <time datetime={app.connectedAt}
										>{dates.format(new Date(app.connectedAt))}</time
									>{' · '}{#if app.lastActiveAt}Last active <time datetime={app.lastActiveAt}
											>{dates.format(new Date(app.lastActiveAt))}</time
										>{:else}Not used yet{/if}{#if app.uri}{' · '}{app.uri}{/if}
								</span>
							</div>
							<div class="actions">
								{#if confirming === app.clientId}
									<span class="confirm">Remove {app.name}?</span>
									<Button size="sm" onclick={() => (confirming = null)}>Keep</Button>
									<Button
										size="sm"
										variant="danger"
										disabled={pending !== null}
										onclick={() => void remove(app.clientId, app.name)}
										>{pending === app.clientId ? 'Removing…' : 'Remove'}</Button
									>
								{:else}
									<Button
										size="sm"
										variant="danger-soft"
										disabled={pending !== null}
										aria-label={`Remove ${app.name}`}
										onclick={() => (confirming = app.clientId)}>Remove…</Button
									>
								{/if}
							</div>
						</li>
					{/each}
				</ul>
				<p class="meta">Removing an app ends its access at once.</p>
			{:else}
				<p class="empty">No apps connected yet.</p>
			{/if}
		</section>

		<ConnectGuide
			{selected}
			onselect={(assistant) => (selected = selected === assistant ? null : assistant)}
		/>

		<p class="foot">
			<Glyph name="lock" size={22} />
			<span>Review requested access before connecting. Disconnect an app whenever you need.</span>
			{#if guideHref}<a href={guideHref}
					>Read the connection guide<Glyph name="arrowUpRight" size={14} /></a
				>{/if}
		</p>
	</div>
</SplitView>

<style>
	.connections {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 2.25rem;
		container-type: inline-size;
	}
	.apps {
		display: grid;
		gap: 0.75rem;
		padding-bottom: 2.25rem;
		border-bottom: 1px solid var(--color-rule);
	}
	h2 {
		color: var(--color-strong);
		font-size: 1.25rem;
		font-weight: 700;
		letter-spacing: -0.02em;
	}
	.empty,
	.meta {
		color: var(--color-lead);
		font-size: 0.9375rem;
	}
	.app-list {
		margin: 0;
		padding: 0;
		list-style: none;
		border: 1px solid var(--color-rule);
		border-radius: var(--radius-md, 0.625rem);
		background: var(--color-paper);
	}
	.app-list li {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		align-items: center;
		gap: 1rem;
		padding: 0.9rem 1.25rem;
	}
	.app-list li + li {
		border-top: 1px solid var(--color-rule);
	}
	.tile {
		display: grid;
		place-items: center;
		width: 2.75rem;
		height: 2.75rem;
		border: 1px solid var(--color-rule);
		border-radius: var(--radius-md, 0.625rem);
		background: var(--color-paper);
		color: var(--color-strong);
		font-weight: 700;
	}
	.main {
		display: grid;
		gap: 0.1rem;
		min-width: 0;
	}
	.name {
		color: var(--color-strong);
		font-weight: 600;
	}
	.main .meta {
		overflow-wrap: anywhere;
		font-size: 0.875rem;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: flex-end;
		gap: 0.5rem;
	}
	.confirm {
		color: var(--color-strong);
		font-size: 0.875rem;
	}
	.foot {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem 0.85rem;
		margin-top: -1rem;
		color: var(--color-lead);
		font-size: 0.875rem;
	}
	.foot :global(svg:first-child) {
		color: var(--color-ink);
	}
	.foot span {
		flex: 1 1 18rem;
	}
	.foot a {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		color: var(--color-link);
	}
	.foot a:hover {
		text-decoration: underline;
		text-underline-offset: 3px;
	}
	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
	@container (max-width: 34rem) {
		.app-list li {
			grid-template-columns: auto minmax(0, 1fr);
		}
		.actions {
			grid-column: 1 / -1;
			justify-content: flex-start;
		}
	}
</style>
