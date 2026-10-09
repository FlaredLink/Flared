<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { GlyphName } from '../icons/Glyph.svelte';
	import Tile, { type TileTone } from './Tile.svelte';

	interface Props {
		// The heading's id; the section is named by it.
		id: string;
		title: string;
		lead?: string;
		icon?: GlyphName;
		tone?: TileTone;
		// Without a border and background, for a section that closes a page.
		plain?: boolean;
		actions?: Snippet;
		children?: Snippet;
	}

	let { id, title, lead, icon, tone, plain = false, actions, children }: Props = $props();
</script>

<section class="panel" class:plain aria-labelledby={id}>
	<header>
		{#if icon}<Tile {icon} {tone} large />{/if}
		<div class="titles">
			<h2 {id}>{title}</h2>
			{#if lead}<p>{lead}</p>{/if}
		</div>
		{#if actions}<div class="actions">{@render actions()}</div>{/if}
	</header>
	{#if children}<div class="body">{@render children()}</div>{/if}
</section>

<style>
	.panel {
		display: grid;
		gap: 1rem;
		min-width: 0;
		padding: 1.25rem 1.5rem;
		border: 1px solid var(--color-rule, #eaecf0);
		border-radius: var(--radius-lg, 12px);
		background: var(--color-surface, #fff);
	}
	.plain {
		padding: 1.25rem 0 0;
		border-width: 1px 0 0;
		border-radius: 0;
		background: none;
	}
	header {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.75rem 1rem;
	}
	.titles {
		display: grid;
		flex: 1 1 14rem;
		gap: 0.2rem;
		min-width: 0;
	}
	h2 {
		color: var(--color-strong, #101828);
		font-size: 1.1rem;
	}
	.titles p {
		color: var(--color-muted, #667085);
		font-size: 0.875rem;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}
	.body {
		display: grid;
		gap: 0.75rem;
		min-width: 0;
	}
</style>
