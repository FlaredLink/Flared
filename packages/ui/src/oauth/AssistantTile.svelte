<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import { onMount } from 'svelte';
	import Glyph from '../icons/Glyph.svelte';
	import AssistantMark from './AssistantMark.svelte';
	import type { AssistantId } from './assistants';

	// The official mark where Flared has it; a glyph tile for the rest.
	let { assistant, size = 44 }: { assistant: AssistantId; size?: number } = $props();
	const mark = $derived(
		assistant === 'claude' ||
			assistant === 'claude-code' ||
			assistant === 'chatgpt' ||
			assistant === 'cursor' ||
			assistant === 'grok'
			? assistant
			: null
	);
	// Microsoft's VS Code icon, unchanged; an image, so its own ids stay apart from the page. The
	// bundler rewrites this pattern in the browser build only, so it runs after mount.
	function vscodeUrl(): string {
		return new URL('./vscode.svg?no-inline', import.meta.url).href;
	}
	let mounted = $state(false);
	onMount(() => {
		mounted = true;
	});
</script>

<span
	class="tile {assistant}"
	class:framed={!mark && assistant !== 'vscode'}
	style:--size="{size}px"
	aria-hidden="true"
>
	{#if mark}
		<AssistantMark assistant={mark} size={Math.round(size * 0.82)} />
	{:else if assistant === 'vscode'}
		{#if mounted}<img
				src={vscodeUrl()}
				alt=""
				width={Math.round(size * 0.7)}
				height={Math.round(size * 0.7)}
			/>{/if}
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
	.other {
		border: 0;
		background: none;
	}
</style>
