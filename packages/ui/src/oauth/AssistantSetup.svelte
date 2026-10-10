<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import Glyph from '../icons/Glyph.svelte';
	import Button from '../atoms/Button.svelte';
	import CopyField from '../molecules/CopyField.svelte';
	import CopyButton from '../molecules/CopyButton.svelte';
	import AssistantTile from './AssistantTile.svelte';
	import { assistants, type AssistantId } from './assistants';

	interface Props {
		assistant: AssistantId;
		// The MCP endpoint of this edition, such as "https://api.flared.page/mcp".
		mcpUrl: string;
		// Every step for each assistant, such as the edition's docs page.
		guideHref?: string;
	}
	let { assistant, mcpUrl, guideHref }: Props = $props();

	const label = $derived(assistants.find((item) => item.id === assistant)?.label ?? 'an assistant');
	const command = $derived(`claude mcp add --transport http flared ${mcpUrl}`);
	// Links that open each client's add-server dialog with Flared filled in. Claude's link is not in
	// Anthropic's documentation, so the manual steps stay beside it. Cursor and VS Code document theirs.
	const claudeLink = $derived(
		`https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Flared&connectorUrl=${encodeURIComponent(mcpUrl)}`
	);
	const cursorLink = $derived(
		`cursor://anysphere.cursor-deeplink/mcp/install?name=flared&config=${encodeURIComponent(btoa(JSON.stringify({ url: mcpUrl })))}`
	);
	const vscodeLink = $derived(
		`vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: 'flared', type: 'http', url: mcpUrl }))}`
	);
	const open = $derived(
		assistant === 'claude'
			? {
					href: claudeLink,
					text: 'Open Claude',
					external: true,
					note: 'Connection is completed in Claude.'
				}
			: assistant === 'cursor'
				? {
						href: cursorLink,
						text: 'Add to Cursor',
						external: false,
						note: 'Opens Cursor with Flared filled in.'
					}
				: assistant === 'vscode'
					? {
							href: vscodeLink,
							text: 'Install in VS Code',
							external: false,
							note: 'Opens VS Code with Flared filled in.'
						}
					: null
	);
</script>

<div class="setup" id="assistant-setup">
	<div class="title">
		<AssistantTile {assistant} size={52} />
		<h3>{assistant === 'other' ? 'Connect another app' : `Connect ${label}`}</h3>
	</div>
	<p class="lead">
		{assistant === 'other'
			? 'Any assistant that supports remote MCP servers with OAuth can connect.'
			: 'Connect through MCP. No API token needed.'}
	</p>
	<div class="url">
		<label for="mcp-url">MCP server URL</label>
		<CopyField id="mcp-url" label="MCP server URL" value={mcpUrl} />
	</div>

	<ol class="steps">
		{#if assistant === 'claude'}
			<li>
				<strong>Open Claude connectors</strong>
				<span>The button below opens the connector form in Claude with Flared filled in.</span>
			</li>
			<li>
				<strong>Add Flared</strong>
				<span
					>If the form opens empty, open <b>Settings</b>, then <b>Connectors</b>, and select
					<b>Add custom connector</b>. Name it Flared and paste the URL above.</span
				>
			</li>
			<li>
				<strong>Review access</strong>
				<span
					>Select <b>Add</b>, then <b>Connect</b>. Sign in to Flared and approve the requested
					permissions.</span
				>
			</li>
		{:else if assistant === 'chatgpt'}
			<li>
				<strong>Turn on Developer mode</strong>
				<span
					>In ChatGPT, open <b>Settings</b>, <b>Apps</b>, then <b>Advanced settings</b>, and turn on
					<b>Developer mode</b>.</span
				>
			</li>
			<li>
				<strong>Create the app</strong>
				<span
					>Select <b>Create app</b>. Name it Flared and paste the URL above. Choose <b>OAuth</b> for authentication
					and leave the client ID and secret empty.</span
				>
			</li>
			<li>
				<strong>Review access</strong>
				<span
					>Confirm and select <b>Create</b>. Sign in to Flared and approve the requested
					permissions.</span
				>
			</li>
			<li>
				<strong>Use it in a chat</strong>
				<span>Add Flared from the <b>+</b> menu.</span>
			</li>
		{:else if assistant === 'cursor'}
			<li>
				<strong>Add Flared to Cursor</strong>
				<span
					>The button below opens Cursor with Flared filled in. Install it, then select
					<b>Connect</b>.</span
				>
			</li>
			<li>
				<strong>Or add it by hand</strong>
				<span
					>Open <b>Cursor Settings</b>, then <b>MCP</b>, and add a server named flared with the URL
					above.</span
				>
			</li>
			<li>
				<strong>Review access</strong>
				<span>Sign in to Flared and approve the requested permissions.</span>
			</li>
		{:else if assistant === 'claude-code'}
			<li>
				<strong>Run this command</strong>
				<span class="command"
					><code>{command}</code><CopyButton text={command} label="Copy command" size="sm" /></span
				>
			</li>
			<li>
				<strong>Sign in</strong>
				<span>In Claude Code, run <code>/mcp</code>, choose flared, and sign in to Flared.</span>
			</li>
		{:else if assistant === 'vscode'}
			<li>
				<strong>Install in VS Code</strong>
				<span
					>The button below opens VS Code with Flared filled in. Install it, then sign in when VS
					Code asks.</span
				>
			</li>
			<li>
				<strong>Or add it by hand</strong>
				<span
					>Run <b>MCP: Add Server</b> from the Command Palette, choose <b>HTTP</b>, and paste the
					URL above.</span
				>
			</li>
		{:else if assistant === 'grok'}
			<li>
				<strong>Open Grok connectors</strong>
				<span>In Grok, open <b>Connectors</b> and select <b>New Connector</b>.</span>
			</li>
			<li>
				<strong>Add Flared</strong>
				<span>Choose <b>Custom</b>. Name it Flared and paste the URL above.</span>
			</li>
			<li>
				<strong>Review access</strong>
				<span>Sign in to Flared and approve the requested permissions.</span>
			</li>
		{:else}
			<li>
				<strong>Add a remote MCP server</strong>
				<span>Paste the URL above where the app adds remote MCP servers.</span>
			</li>
			<li>
				<strong>Review access</strong>
				<span>Sign in to Flared when the app asks, and approve the requested permissions.</span>
			</li>
		{/if}
	</ol>

	{#if open}
		<Button
			variant="primary"
			size="lg"
			wide
			href={open.href}
			target={open.external ? '_blank' : undefined}
			rel={open.external ? 'noopener' : undefined}
			trailing="arrowUpRight">{open.text}</Button
		>
		<p class="note">{open.note}</p>
	{:else}
		<p class="note">Flared shows what the assistant asks for before you approve.</p>
	{/if}

	{#if guideHref}
		<a class="guide" href={guideHref}>Full setup guide<Glyph name="arrowUpRight" size={16} /></a>
	{/if}
</div>

<style>
	.setup {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 1.1rem;
		min-width: 0;
	}
	.title {
		display: flex;
		align-items: center;
		gap: 1rem;
	}
	h3 {
		color: var(--color-strong);
		font-size: 1.625rem;
		font-weight: 750;
		letter-spacing: -0.035em;
		line-height: 1.15;
	}
	.lead {
		color: var(--color-lead);
		font-size: 1rem;
	}
	.url {
		display: grid;
		gap: 0.45rem;
		padding-bottom: 1.25rem;
		border-bottom: 1px solid var(--color-rule);
	}
	label {
		color: var(--color-strong);
		font-size: 0.9375rem;
	}
	.steps {
		display: grid;
		gap: 1.25rem;
		margin: 0;
		padding: 0;
		list-style: none;
		counter-reset: step;
	}
	.steps li {
		position: relative;
		display: grid;
		gap: 0.2rem;
		min-height: 2.5rem;
		padding-left: 3.25rem;
		counter-increment: step;
	}
	.steps li::before {
		content: counter(step);
		position: absolute;
		top: 0;
		left: 0;
		display: grid;
		place-items: center;
		width: 2.25rem;
		height: 2.25rem;
		border-radius: 50%;
		background: var(--color-selected);
		color: var(--color-strong);
		font-size: 0.9375rem;
		font-weight: 650;
	}
	.steps strong {
		color: var(--color-strong);
		font-size: 1rem;
		font-weight: 650;
	}
	.steps span {
		color: var(--color-lead);
		font-size: 0.9375rem;
	}
	.steps b {
		color: var(--color-ink);
		font-weight: 600;
	}
	.command {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-top: 0.35rem;
		padding: 0.4rem 0.4rem 0.4rem 0.75rem;
		border: 1px solid var(--color-rule);
		border-radius: var(--radius-control, 0.5rem);
		background: var(--color-selected);
	}
	code {
		overflow-wrap: anywhere;
		color: var(--color-strong);
		font-family: var(--font-mono);
		font-size: 0.8125rem;
	}
	.note {
		margin-top: -0.4rem;
		color: var(--color-lead);
		font-size: 0.9375rem;
		text-align: center;
	}
	.guide {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.4rem;
		padding-top: 1.1rem;
		border-top: 1px solid var(--color-rule);
		color: var(--color-link);
		font-size: 1rem;
	}
	.guide:hover {
		text-decoration: underline;
		text-underline-offset: 3px;
	}
</style>
