<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts" module>
	export interface Crumb {
		label: string;
		href?: string;
	}
</script>

<script lang="ts">
	// The last crumb is the current page.
	let { items }: { items: Crumb[] } = $props();
</script>

<nav class="crumbs" aria-label="Breadcrumb">
	<ol>
		{#each items as item, index (index)}
			<li>
				{#if index === items.length - 1}<span aria-current="page">{item.label}</span
					>{:else if item.href}<a href={item.href}>{item.label}</a>{:else}<span>{item.label}</span
					>{/if}
			</li>
		{/each}
	</ol>
</nav>

<style>
	ol {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		margin: 0;
		padding: 0;
		list-style: none;
		color: var(--color-lead);
		font-size: 0.9375rem;
	}
	li {
		display: flex;
		align-items: center;
		min-width: 0;
	}
	li + li::before {
		content: '/';
		margin: 0 0.6rem;
		color: var(--color-muted);
	}
	a:hover {
		color: var(--color-strong);
	}
	[aria-current='page'] {
		overflow: hidden;
		color: var(--color-strong);
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
