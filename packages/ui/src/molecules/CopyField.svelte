<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import CopyButton from './CopyButton.svelte';

	// A read-only value with a copy button, such as the MCP server URL.
	let { value, label, id }: { value: string; label: string; id: string } = $props();
</script>

<div class="copy-field">
	<input
		{id}
		{value}
		readonly
		aria-label={label}
		onfocus={(event) => event.currentTarget.select()}
	/>
	<CopyButton text={value} label="Copy {label.toLocaleLowerCase()}" size="sm" />
</div>

<style>
	.copy-field {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-height: 3rem;
		padding: 0 0.4rem 0 0.9rem;
		border: 1px solid var(--color-rule);
		border-radius: var(--radius-control, 0.5rem);
		background: var(--color-selected);
	}
	input {
		flex: 1;
		min-width: 0;
		padding: 0;
		border: 0;
		background: transparent;
		color: var(--color-strong);
		font: inherit;
		font-family: var(--font-mono);
		font-size: 0.875rem;
		outline: none;
		text-overflow: ellipsis;
	}
	.copy-field:focus-within {
		outline: 2px solid var(--color-focus);
		outline-offset: 2px;
	}
</style>
