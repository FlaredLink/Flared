<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts" module>
	export interface TabItem {
		value: string;
		label: string;
	}
	// The ids a panel needs: role="tabpanel", id={tabPanelId(...)}, aria-labelledby={tabId(...)}.
	export const tabId = (prefix: string, value: string) => `${prefix}-tab-${value}`;
	export const tabPanelId = (prefix: string, value: string) => `${prefix}-panel-${value}`;
</script>

<script lang="ts">
	interface Props {
		items: TabItem[];
		value: string;
		label: string;
		idPrefix: string;
		size?: 'md' | 'sm';
		onchange?: (value: string) => void;
	}
	let { items, value = $bindable(), label, idPrefix, size = 'md', onchange }: Props = $props();
	let list = $state<HTMLDivElement>();

	function select(next: string) {
		value = next;
		onchange?.(next);
	}

	// Arrow keys move between tabs and select them, as in the WAI-ARIA tabs pattern.
	function keydown(event: KeyboardEvent) {
		const index = items.findIndex((item) => item.value === value);
		const moves: Record<string, number> = {
			ArrowRight: index + 1,
			ArrowLeft: index - 1,
			Home: 0,
			End: items.length - 1
		};
		const target = moves[event.key];
		if (target === undefined) return;
		event.preventDefault();
		const next = items[(target + items.length) % items.length];
		select(next.value);
		list?.querySelector<HTMLButtonElement>(`#${CSS.escape(tabId(idPrefix, next.value))}`)?.focus();
	}
</script>

<div
	class="tabs {size}"
	role="tablist"
	aria-label={label}
	bind:this={list}
	tabindex="-1"
	onkeydown={keydown}
>
	{#each items as item (item.value)}
		<button
			type="button"
			role="tab"
			id={tabId(idPrefix, item.value)}
			aria-controls={tabPanelId(idPrefix, item.value)}
			aria-selected={item.value === value}
			tabindex={item.value === value ? 0 : -1}
			onclick={() => select(item.value)}>{item.label}</button
		>
	{/each}
</div>

<style>
	.tabs {
		display: flex;
		gap: 1.75rem;
		overflow-x: auto;
		box-shadow: inset 0 -1px var(--color-rule);
		scrollbar-width: none;
	}
	.sm {
		gap: 1.25rem;
	}
	button {
		flex: none;
		min-height: 2.75rem;
		padding: 0.5rem 0.25rem;
		border: 0;
		border-bottom: 2px solid transparent;
		background: none;
		color: var(--color-lead);
		font: inherit;
		font-size: 1rem;
		cursor: pointer;
	}
	.sm button {
		min-height: 2.25rem;
		padding-inline: 0;
		font-size: 0.9375rem;
	}
	button:hover {
		color: var(--color-strong);
	}
	button[aria-selected='true'] {
		border-bottom-color: var(--color-accent);
		color: var(--color-strong);
		font-weight: 600;
	}
	.sm button[aria-selected='true'] {
		font-size: 1rem;
	}
</style>
