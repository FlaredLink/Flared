<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		// The heading's id, for aria-labelledby on the section.
		id?: string;
		title: string;
		lead?: string;
		level?: 2 | 3;
		actions?: Snippet;
	}
	let { id, title, lead, level = 2, actions }: Props = $props();
</script>

<div class="section-header">
	<div class="titles">
		<svelte:element this={`h${level}`} {id} class="title level-{level}">{title}</svelte:element>
		{#if lead}<p>{lead}</p>{/if}
	</div>
	{#if actions}<div class="actions">{@render actions()}</div>{/if}
</div>

<style>
	.section-header {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		justify-content: space-between;
		gap: 0.75rem 1.5rem;
	}
	.titles {
		display: grid;
		gap: 0.25rem;
		min-width: 0;
	}
	.title {
		color: var(--color-strong);
		font-weight: 750;
		letter-spacing: -0.03em;
		line-height: 1.2;
	}
	.level-2 {
		font-size: 1.5rem;
	}
	.level-3 {
		font-size: 1.125rem;
		letter-spacing: -0.02em;
	}
	p {
		color: var(--color-lead);
		font-size: 0.9875rem;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
	}
</style>
