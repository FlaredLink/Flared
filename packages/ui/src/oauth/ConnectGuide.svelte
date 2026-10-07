<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	interface Props {
		// The MCP endpoint of this edition, such as "https://api.flared.page/mcp".
		mcpUrl: string;
	}

	let { mcpUrl }: Props = $props();

	const assistants = [
		{ id: 'claude', label: 'Claude' },
		{ id: 'chatgpt', label: 'ChatGPT' },
		{ id: 'claude-code', label: 'Claude Code' },
		{ id: 'cursor', label: 'Cursor' },
		{ id: 'vscode', label: 'VS Code' },
		{ id: 'grok', label: 'Grok' },
		{ id: 'other', label: 'Other' }
	] as const;
	type Assistant = (typeof assistants)[number]['id'];

	let selected = $state<Assistant>('claude');
	let copied = $state('');
	const command = $derived(`claude mcp add --transport http flared ${mcpUrl}`);
	// Links that open each client's add-server dialog with Flared filled in. Claude's link is not in
	// Anthropic's documentation, so the manual steps stay below it. Cursor and VS Code document theirs.
	const claudeLink = $derived(
		`https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Flared&connectorUrl=${encodeURIComponent(mcpUrl)}`
	);
	const cursorLink = $derived(
		`cursor://anysphere.cursor-deeplink/mcp/install?name=flared&config=${encodeURIComponent(btoa(JSON.stringify({ url: mcpUrl })))}`
	);
	const vscodeLink = $derived(
		`vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: 'flared', type: 'http', url: mcpUrl }))}`
	);
	const tabs: HTMLButtonElement[] = [];

	async function copy(value: string, label: string) {
		try {
			await navigator.clipboard.writeText(value);
			copied = `${label} copied.`;
		} catch {
			copied = `Select the ${label.toLowerCase()} and copy it.`;
		}
	}

	// Arrow keys move between tabs, as in the ARIA tabs pattern.
	function move(event: KeyboardEvent, index: number) {
		const count = assistants.length;
		let next: number;
		if (event.key === 'ArrowRight') next = (index + 1) % count;
		else if (event.key === 'ArrowLeft') next = (index - 1 + count) % count;
		else if (event.key === 'Home') next = 0;
		else if (event.key === 'End') next = count - 1;
		else return;
		event.preventDefault();
		selected = assistants[next].id;
		tabs[next]?.focus();
	}
</script>

<div class="guide" role="region" aria-labelledby="connect-heading">
	<h3 id="connect-heading">Connect an AI assistant</h3>
	<div class="field">
		<label for="mcp-url">MCP server URL</label>
		<div class="copy-row">
			<input
				id="mcp-url"
				readonly
				value={mcpUrl}
				spellcheck="false"
				onfocus={(event) => event.currentTarget.select()}
			/>
			<button type="button" onclick={() => void copy(mcpUrl, 'URL')}>Copy</button>
		</div>
	</div>

	<div class="tabs" role="tablist" aria-label="Assistant">
		{#each assistants as assistant, index (assistant.id)}
			<button
				bind:this={tabs[index]}
				type="button"
				role="tab"
				id={`connect-tab-${assistant.id}`}
				aria-selected={selected === assistant.id}
				aria-controls="connect-panel"
				tabindex={selected === assistant.id ? 0 : -1}
				onclick={() => (selected = assistant.id)}
				onkeydown={(event) => move(event, index)}>{assistant.label}</button
			>
		{/each}
	</div>

	<div id="connect-panel" class="panel" role="tabpanel" aria-labelledby={`connect-tab-${selected}`}>
		{#if selected === 'claude'}
			<p class="open-row">
				<a class="open" href={claudeLink} target="_blank" rel="noopener">Add to Claude</a>
				<span>Opens Claude with Flared filled in. Select <strong>Add</strong>, then sign in.</span>
			</p>
			<p>If the form opens empty:</p>
			<ol>
				<li>In Claude, open <strong>Settings</strong>, then <strong>Connectors</strong>.</li>
				<li>
					Select <strong>Add custom connector</strong>. Name it Flared and paste the URL.
				</li>
				<li>Select <strong>Add</strong>, then <strong>Connect</strong>.</li>
				<li>Sign in to Flared and approve the access.</li>
			</ol>
		{:else if selected === 'chatgpt'}
			<ol>
				<li>
					In ChatGPT, open <strong>Settings</strong>, <strong>Apps</strong>, then
					<strong>Advanced settings</strong>. Turn on <strong>Developer mode</strong>.
				</li>
				<li>Select <strong>Create app</strong>. Name it Flared and paste the URL.</li>
				<li>
					Choose <strong>OAuth</strong> for authentication. Leave the client ID and secret empty.
				</li>
				<li>
					Confirm and select <strong>Create</strong>. Sign in to Flared and approve the access.
				</li>
				<li>In a chat, add Flared from the <strong>+</strong> menu.</li>
			</ol>
		{:else if selected === 'grok'}
			<ol>
				<li>
					In Grok, open <strong>Connectors</strong> and select <strong>New Connector</strong>.
				</li>
				<li>Choose <strong>Custom</strong>. Name it Flared and paste the URL.</li>
				<li>Sign in to Flared and approve the access.</li>
			</ol>
		{:else if selected === 'claude-code'}
			<ol>
				<li>
					Run this command:
					<span class="copy-row">
						<code>{command}</code>
						<button type="button" onclick={() => void copy(command, 'Command')}>Copy</button>
					</span>
				</li>
				<li>In Claude Code, run <code>/mcp</code>, choose flared, and sign in.</li>
			</ol>
		{:else if selected === 'cursor'}
			<p class="open-row">
				<a class="open" href={cursorLink}>Add to Cursor</a>
				<span
					>Opens Cursor with Flared filled in. Install it, then select <strong>Connect</strong
					>.</span
				>
			</p>
			<p>
				Or open <strong>Cursor Settings</strong>, then <strong>MCP</strong>, add a server named
				flared with the URL above, and sign in.
			</p>
		{:else if selected === 'vscode'}
			<p class="open-row">
				<a class="open" href={vscodeLink}>Install in VS Code</a>
				<span>Opens VS Code with Flared filled in. Install it, then sign in when VS Code asks.</span
				>
			</p>
			<p>
				Or run <strong>MCP: Add Server</strong> from the Command Palette, choose
				<strong>HTTP</strong>, and paste the URL above.
			</p>
		{:else}
			<p>
				Any assistant that supports remote MCP servers with OAuth can connect. Add the URL as a
				remote MCP server, then sign in to Flared when the assistant asks.
			</p>
		{/if}
	</div>

	<p class="note">
		You need no API token. Flared shows what the assistant asks for before you approve.
	</p>
	<p class="status" role="status" aria-live="polite">{copied}</p>
</div>

<style>
	.guide {
		display: grid;
		gap: 0.85rem;
		padding: 1rem;
		border: 1px solid var(--color-rule, #d0d5dd);
		border-radius: var(--radius-md, 8px);
		background: var(--color-surface, #f9fafb);
	}
	h3 {
		font-size: 0.95rem;
	}
	.field {
		display: grid;
		gap: 0.35rem;
	}
	label {
		color: var(--color-strong, #101828);
		font-size: 0.8rem;
		font-weight: 650;
	}
	.copy-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
	}
	input {
		flex: 1 1 16rem;
		min-height: 40px;
		padding: 0.5rem 0.7rem;
		border: 1px solid var(--color-rule, #d0d5dd);
		border-radius: var(--radius-sm, 6px);
		background: var(--color-paper, #fff);
		color: var(--color-ink, #101828);
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 0.8rem;
	}
	.tabs {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem;
		border-bottom: 1px solid var(--color-rule, #d0d5dd);
	}
	[role='tab'] {
		min-height: 40px;
		margin-bottom: -1px;
		padding: 0.4rem 0.75rem;
		border: 0;
		border-bottom: 2px solid transparent;
		background: none;
		color: var(--color-muted, #667085);
		font-size: 0.85rem;
		font-weight: 600;
	}
	[role='tab']:hover {
		color: var(--color-strong, #101828);
	}
	[role='tab'][aria-selected='true'] {
		border-bottom-color: var(--color-button-primary, #c94b00);
		color: var(--color-strong, #101828);
	}
	.panel {
		display: grid;
		gap: 0.6rem;
		font-size: 0.875rem;
	}
	.open-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem 0.75rem;
	}
	.open {
		display: inline-flex;
		align-items: center;
		min-height: 40px;
		padding: 0.4rem 0.9rem;
		border-radius: var(--radius-sm, 6px);
		background: var(--color-button-primary, #c94b00);
		color: var(--color-on-primary, #fff);
		font-weight: 620;
		text-decoration: none;
	}
	.open:hover {
		background: var(--color-button-primary-hover, #b84400);
	}
	.open-row span {
		color: var(--color-muted, #667085);
		font-size: 0.8rem;
	}
	ol {
		display: grid;
		gap: 0.45rem;
		margin: 0;
		padding-left: 1.25rem;
	}
	li .copy-row {
		margin-top: 0.4rem;
	}
	code {
		padding: 0.1rem 0.35rem;
		border-radius: var(--radius-sm, 6px);
		background: var(--color-paper, #fff);
		border: 1px solid var(--color-rule, #d0d5dd);
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 0.78rem;
		overflow-wrap: anywhere;
	}
	.copy-row code {
		flex: 1 1 16rem;
		padding: 0.5rem 0.7rem;
	}
	.note,
	.status {
		color: var(--color-muted, #667085);
		font-size: 0.8rem;
	}
	.status:empty {
		display: none;
	}
	button:not([role='tab']) {
		min-height: 40px;
		padding: 0.4rem 0.8rem;
		border: 1px solid var(--color-rule, #d0d5dd);
		border-radius: var(--radius-sm, 6px);
		background: var(--color-paper, #fff);
		color: var(--color-ink, #101828);
		font-size: 0.8rem;
		font-weight: 600;
	}
	button:not([role='tab']):hover {
		border-color: var(--color-muted, #667085);
	}
</style>
