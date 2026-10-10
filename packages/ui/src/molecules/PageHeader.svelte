<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import Breadcrumbs, { type Crumb } from './Breadcrumbs.svelte';

	interface Props {
		crumbs?: Crumb[];
		title: string;
		// A count beside the title, such as the number of links.
		count?: number;
		lead?: string;
		// A fact or control at the top right, level with the breadcrumb.
		top?: Snippet;
		// Facts or actions at the right of the title.
		aside?: Snippet;
		// Content under the title, such as status or a back link.
		children?: Snippet;
	}
	let { crumbs, title, count, lead, top, aside, children }: Props = $props();
	const numbers = new Intl.NumberFormat();
</script>

<header class="page-header">
	{#if crumbs || top}
		<div class="bar">
			{#if crumbs}<Breadcrumbs items={crumbs} />{/if}
			{#if top}<div class="top">{@render top()}</div>{/if}
		</div>
	{/if}
	<div class="row">
		<div class="titles">
			<h1>
				{title}{#if count !== undefined}<span class="count">{numbers.format(count)}</span>{/if}
			</h1>
			{#if lead}<p class="lead">{lead}</p>{/if}
			{#if children}{@render children()}{/if}
		</div>
		{#if aside}<div class="aside">{@render aside()}</div>{/if}
	</div>
</header>

<style>
	.page-header {
		display: grid;
		gap: 1.1rem;
		margin-bottom: 1.75rem;
	}
	.bar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem 1rem;
		min-height: 2.25rem;
	}
	.top {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		margin-left: auto;
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		justify-content: space-between;
		gap: 0.75rem 1.5rem;
	}
	.titles {
		display: grid;
		gap: 0.35rem;
		min-width: 0;
	}
	h1 {
		display: flex;
		align-items: flex-start;
		gap: 0.6rem;
		color: var(--color-strong);
		font-size: clamp(2rem, 3.2vw, 2.75rem);
		font-weight: 800;
		letter-spacing: -0.045em;
		line-height: 1.05;
	}
	.count {
		margin-top: 0.2em;
		color: var(--color-lead);
		font-size: 0.45em;
		font-weight: 500;
		letter-spacing: 0;
	}
	.lead {
		color: var(--color-lead);
		font-size: 1.0625rem;
	}
	.aside {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.75rem;
		color: var(--color-lead);
		font-size: 0.9375rem;
	}
</style>
