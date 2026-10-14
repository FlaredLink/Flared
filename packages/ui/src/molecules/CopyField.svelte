<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import CopyButton from './CopyButton.svelte';

	// A read-only value with a copy button, such as the MCP server URL. The whole value stays
	// visible: it wraps after dots and slashes, and one click selects all of it for a manual copy.
	let { value, label, id }: { value: string; label: string; id: string } = $props();
	const parts = $derived(value.split(/(?<=[./?&])/));
</script>

<div class="copy-field">
	<code {id}
		>{#each parts as part}{part}<wbr />{/each}</code
	>
	<CopyButton text={value} label="Copy {label.toLocaleLowerCase()}" size="sm" />
</div>

<style>
	.copy-field {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-height: 3rem;
		padding: 0.55rem 0.4rem 0.55rem 0.9rem;
		border: 1px solid var(--color-rule);
		border-radius: var(--radius-control, 0.5rem);
		background: var(--color-selected);
	}
	code {
		flex: 1;
		min-width: 0;
		color: var(--color-strong);
		font-family: var(--font-mono);
		font-size: 0.875rem;
		line-height: 1.45;
		overflow-wrap: anywhere;
		user-select: all;
	}
</style>
