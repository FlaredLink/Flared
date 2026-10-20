<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		title: string;
		description?: string;
		// The heading's id, when a control is labelled by it.
		id?: string;
		// The value or control under the text.
		children?: Snippet;
	}
	let { title, description, id, children }: Props = $props();
</script>

<!-- The title, the description, and the control stack at every width; a soft line separates
     one row from the next. -->
<div class="setting-row">
	<h3 {id}>{title}</h3>
	{#if description}<p>{description}</p>{/if}
	{#if children}<div class="control">{@render children()}</div>{/if}
</div>

<style>
	.setting-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 0.25rem;
		padding: 1.125rem 0;
		border-bottom: 1px solid var(--color-rule-soft);
	}
	.setting-row:last-child {
		border-bottom: 0;
	}
	h3 {
		color: var(--color-strong);
		font-size: 0.9375rem;
		font-weight: 600;
	}
	p {
		color: var(--color-lead);
		font-size: 0.875rem;
		line-height: 1.5;
	}
	.control {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
		margin-top: 0.5rem;
	}
</style>
