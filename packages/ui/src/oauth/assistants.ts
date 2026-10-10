// SPDX-License-Identifier: AGPL-3.0-only
// The assistants the Connections setup covers, in the order the list shows them.
export const assistants = [
	{ id: 'claude', label: 'Claude', line: 'Use Flared in Claude' },
	{ id: 'chatgpt', label: 'ChatGPT', line: 'Use Flared in ChatGPT' },
	{ id: 'cursor', label: 'Cursor', line: 'Use Flared in your editor' },
	{ id: 'claude-code', label: 'Claude Code', line: 'Use Flared from your terminal' },
	{ id: 'vscode', label: 'VS Code', line: 'Use Flared in your editor' },
	{ id: 'grok', label: 'Grok', line: 'Use Flared in Grok' },
	{ id: 'other', label: 'Other MCP app', line: 'Connect any compatible assistant' }
] as const;

export type AssistantId = (typeof assistants)[number]['id'];
