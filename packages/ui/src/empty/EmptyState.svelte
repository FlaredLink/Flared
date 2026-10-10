<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import Glyph, { type GlyphName } from '../icons/Glyph.svelte';

	interface Props {
		title?: string;
		icon?: GlyphName;
		// Buttons or links under the text.
		actions?: Snippet;
		children: Snippet;
	}
	let { title, icon = 'link', actions, children }: Props = $props();
</script>

<div class="empty-state">
	<span class="icon"><Glyph name={icon} size={44} /></span>
	{#if title}<p class="title">{title}</p>{/if}
	<p class="text">{@render children()}</p>
	{#if actions}<div class="actions">{@render actions()}</div>{/if}
</div>

<style>
	.empty-state {
		display: grid;
		justify-items: center;
		gap: 0.4rem;
		padding: 2rem 1rem;
		text-align: center;
	}
	.icon {
		display: grid;
		margin-bottom: 0.5rem;
		color: var(--color-lead);
	}
	.title {
		color: var(--color-strong);
		font-size: 1.375rem;
		font-weight: 750;
		letter-spacing: -0.025em;
	}
	.text {
		max-width: 30rem;
		color: var(--color-lead);
		font-size: 1rem;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: 0.75rem;
		margin-top: 0.75rem;
	}
</style>
