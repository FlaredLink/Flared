<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import { onMount } from 'svelte';
	import {
		scopeDescriptions,
		type ConnectedApp,
		type ConnectedAppPage
	} from '@flared/contracts/oauth';
	import Glyph from '../icons/Glyph.svelte';
	import Button from '../atoms/Button.svelte';
	import SplitView from '../molecules/SplitView.svelte';
	import SidePanel from '../molecules/SidePanel.svelte';
	import Callout from '../molecules/Callout.svelte';
	import CopyButton from '../molecules/CopyButton.svelte';
	import { revokeConnectedApp } from './client';
	import { shownWorkspace } from '../workspace/shown';
	import { linkErrorMessage } from '../links/messages';
	import AssistantTile from './AssistantTile.svelte';
	import AssistantSetup from './AssistantSetup.svelte';
	import { assistants, type AssistantId } from './assistants';

	interface Props {
		page: ConnectedAppPage;
		// The path of the /v1 API for this browser, such as "/api/v1".
		apiBase: string;
		// The MCP endpoint that the section head and the setup steps show.
		mcpUrl: string;
		// Called after a removal succeeds, so the app reloads the list.
		onChanged: () => void | Promise<void>;
		// Every step for each assistant, such as the edition's docs page.
		guideHref?: string;
	}

	let { page, apiBase, mcpUrl, onChanged, guideHref }: Props = $props();
	const workspace = shownWorkspace();
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
	// The address without its scheme fits the section head; the copy button copies all of it.
	const mcpAddress = $derived(mcpUrl.replace(/^https?:\/\//, ''));
	// Assistants use the MCP endpoint. Apps that the operator registered, such as Zapier or the
	// browser extension, use the REST API and get a list of their own.
	const connectedAssistants = $derived(page.apps.filter((app) => app.kind === 'assistant'));
	const connectedApps = $derived(page.apps.filter((app) => app.kind === 'app'));
	// One list: the connected assistants, then the setup of each assistant not connected yet.
	const unconnected = $derived(
		assistants.filter(
			(assistant) => !connectedAssistants.some((app) => app.assistant === assistant.id)
		)
	);

	// With room for two columns and nothing connected yet, Claude's setup opens, as in the mockups.
	onMount(() => {
		if (connectedAssistants.length === 0 && window.matchMedia('(min-width: 75rem)').matches)
			selected = 'claude';
	});

	async function remove(clientId: string, name: string) {
		pending = clientId;
		error = '';
		status = '';
		const result = await revokeConnectedApp(apiBase, clientId, workspace());
		pending = null;
		confirming = null;
		if (!result.ok && result.code !== 'NOT_FOUND') {
			error = linkErrorMessage(result.code, 'Something went wrong. Try again.');
			return;
		}
		status = `Removed ${name}.`;
		await onChanged();
	}
</script>

<!-- The panel is passed only while a setup is open, so the list keeps the full width. -->
{#snippet setup()}
	{#if selected}
		<SidePanel id="assistant-setup-label" label="Assistant setup" onclose={() => (selected = null)}>
			<AssistantSetup assistant={selected} {mcpUrl} {guideHref} />
		</SidePanel>
	{/if}
{/snippet}

{#snippet connected(app: ConnectedApp)}
	<li class="item" class:confirming={confirming === app.clientId}>
		<span class="logo" aria-hidden="true"
			>{#if app.assistant}<AssistantTile assistant={app.assistant} size={22} />{:else}{(
					Array.from(app.name)[0] ?? '?'
				).toLocaleUpperCase()}{/if}</span
		>
		<div class="main">
			<span class="name">{app.name}</span>
			<span class="meta">{sentence(app.scopes.map((scope) => scopeDescriptions[scope]))}</span>
			<span class="meta">
				Connected <time datetime={app.connectedAt}>{dates.format(new Date(app.connectedAt))}</time
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
					disabled={pending !== null}
					aria-label={`Remove ${app.name}`}
					onclick={() => (confirming = app.clientId)}>Remove…</Button
				>
			{/if}
		</div>
	</li>
{/snippet}

<SplitView panel={selected ? setup : undefined}>
	<div class="lists">
		<p class="visually-hidden" role="status" aria-live="polite">{status}</p>
		{#if error}<Callout tone="danger" role="alert"><p>{error}</p></Callout>{/if}

		<section class="group" aria-labelledby="assistants-heading">
			<div class="section-head">
				<Glyph name="robot" size={18} />
				<h2 id="assistants-heading">AI assistants</h2>
				<span class="address">
					<span class="visually-hidden">MCP server address: </span><code>{mcpAddress}</code>
					<CopyButton text={mcpUrl} label="Copy the MCP server address" size="sm" />
				</span>
			</div>

			<ul class="items">
				{#each connectedAssistants as app (app.clientId)}
					{@render connected(app)}
				{/each}
				{#each unconnected as assistant (assistant.id)}
					<li class="item" class:selected={selected === assistant.id}>
						<span class="logo" aria-hidden="true"
							><AssistantTile assistant={assistant.id} size={22} /></span
						>
						<div class="main">
							<span class="name">{assistant.label}</span>
							<span class="meta">{assistant.line}</span>
						</div>
						<div class="actions">
							<Button
								size="sm"
								aria-expanded={selected === assistant.id}
								aria-controls="assistant-setup"
								aria-label={`Set up ${assistant.label}`}
								onclick={() => (selected = selected === assistant.id ? null : assistant.id)}
								>{assistant.id === 'other' ? 'View setup' : 'Set up'}</Button
							>
						</div>
					</li>
				{/each}
			</ul>
		</section>

		{#if connectedApps.length > 0}
			<section class="group" aria-labelledby="apps-heading">
				<div class="section-head">
					<Glyph name="plugs" size={18} />
					<h2 id="apps-heading">Apps</h2>
				</div>
				<p class="lead">Apps you signed in to with your Flared account, such as Zapier.</p>
				<ul class="items">
					{#each connectedApps as app (app.clientId)}
						{@render connected(app)}
					{/each}
				</ul>
			</section>
		{/if}

		<p class="foot">
			<Glyph name="lock" size={18} />
			<span
				>Review requested access before connecting. Removing an app ends its access at once.</span
			>
			{#if guideHref}<a href={guideHref}
					>Read the connection guide<Glyph name="arrowUpRight" size={14} /></a
				>{/if}
		</p>
	</div>
</SplitView>

<style>
	.lists {
		display: grid;
		gap: 1.5rem;
	}
	.group {
		display: grid;
		gap: 0.625rem;
	}
	.lead {
		color: var(--color-subtle);
		font-size: 0.8125rem;
	}
	.section-head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem 0.625rem;
		color: var(--color-strong);
	}
	h2 {
		color: var(--color-strong);
		font-size: 0.9375rem;
		font-weight: 600;
	}
	/* The address field: grey like a read-only field, with the copy button at its end. */
	.address {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		min-width: 0;
		max-width: 100%;
		margin-left: auto;
		padding: 0 0.125rem 0 0.625rem;
		border-radius: 0.5625rem;
		background: var(--color-surface-2);
	}
	.address code {
		min-width: 0;
		overflow-wrap: anywhere;
		color: var(--color-ink);
		font-size: 0.8125rem;
	}
	.items {
		display: grid;
		gap: 0.5rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.item {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		align-items: center;
		gap: 0.625rem 0.75rem;
		padding: 0.75rem 0.875rem;
		border-radius: 0.75rem;
		background: var(--color-surface);
		box-shadow: var(--shadow-ring);
	}
	.item.selected {
		background: var(--color-surface-2);
	}
	.logo {
		display: grid;
		flex: none;
		place-items: center;
		width: 2.125rem;
		height: 2.125rem;
		border-radius: 0.5625rem;
		background: var(--color-surface-2);
		box-shadow: var(--shadow-ring);
		color: var(--color-strong);
		font-weight: 600;
	}
	.main {
		display: grid;
		gap: 0.125rem;
		min-width: 0;
	}
	.name {
		color: var(--color-strong);
		font-weight: 500;
	}
	.meta {
		overflow-wrap: anywhere;
		color: var(--color-subtle);
		font-size: 0.8125rem;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: flex-end;
		gap: 0.5rem;
	}
	/* The question and its two buttons take a line of their own under the text. */
	.confirming .actions {
		grid-column: 1 / -1;
		justify-content: flex-start;
	}
	.confirm {
		color: var(--color-strong);
		font-size: 0.875rem;
	}
	.foot {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.375rem 0.625rem;
		margin-top: 0.25rem;
		color: var(--color-subtle);
		font-size: 0.8125rem;
	}
	.foot span {
		flex: 1 1 18rem;
	}
	.foot a {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		color: var(--color-link);
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
</style>
