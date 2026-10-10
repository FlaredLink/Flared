<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import Glyph from '../icons/Glyph.svelte';
	import AssistantMark from './AssistantMark.svelte';
	import type { AssistantId } from './assistants';

	// The official mark where Flared has it; a glyph tile for the rest.
	let { assistant, size = 44 }: { assistant: AssistantId; size?: number } = $props();
	const mark = $derived(
		assistant === 'claude' || assistant === 'chatgpt' || assistant === 'cursor' ? assistant : null
	);
</script>

<span class="tile {assistant}" class:framed={!mark} style:--size="{size}px" aria-hidden="true">
	{#if mark}
		<AssistantMark assistant={mark} size={Math.round(size * 0.82)} />
	{:else if assistant === 'claude-code'}
		<Glyph name="terminal" size={Math.round(size * 0.6)} />
	{:else if assistant === 'vscode'}
		<Glyph name="code" size={Math.round(size * 0.6)} />
	{:else if assistant === 'grok'}
		<span class="letter">G</span>
	{:else}
		<Glyph name="share" size={Math.round(size * 0.66)} />
	{/if}
</span>

<style>
	.tile {
		display: inline-grid;
		flex: none;
		place-items: center;
		width: var(--size);
		height: var(--size);
		border-radius: var(--radius-md, 0.625rem);
		color: var(--color-strong);
	}
	.framed {
		border: 1px solid var(--color-rule);
		background: var(--color-paper);
	}
	.claude-code {
		border-color: var(--color-tile-charcoal);
		background: var(--color-tile-charcoal);
		color: var(--color-tile-charcoal-icon);
	}
	.other {
		border: 0;
		background: none;
	}
	.letter {
		font-size: calc(var(--size) * 0.45);
		font-weight: 750;
	}
</style>
