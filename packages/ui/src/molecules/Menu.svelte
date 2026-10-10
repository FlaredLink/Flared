<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts" module>
	import type { GlyphName } from '../icons/Glyph.svelte';

	export type MenuItem =
		| { label: string; icon?: GlyphName; href: string; external?: boolean; danger?: boolean }
		| {
				label: string;
				icon?: GlyphName;
				onselect: () => void;
				danger?: boolean;
				disabled?: boolean;
				// One of a set of choices: true marks the current one with a check.
				checked?: boolean;
				// Short text at the end of the item, such as a plan.
				detail?: string;
		  }
		// A line between groups of items.
		| { divider: true };
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import Glyph from '../icons/Glyph.svelte';

	interface Props {
		items: MenuItem[];
		// The trigger's accessible name, such as "More actions for Product launch".
		label: string;
		id: string;
		icon?: GlyphName;
		// Text beside the icon; without it the trigger is an icon button.
		text?: string;
		align?: 'start' | 'end';
		// A mark that replaces the icon, such as an avatar, and the caret after the text.
		lead?: Snippet;
		caret?: GlyphName;
		// Content above the items, such as the signed-in email.
		heading?: Snippet;
		class?: string;
	}
	let {
		items,
		label,
		id,
		icon = 'dots',
		text,
		align = 'end',
		lead,
		caret = 'caret',
		heading,
		class: className = ''
	}: Props = $props();
	let trigger = $state<HTMLButtonElement>();
	let menu = $state<HTMLDivElement>();
	let open = $state(false);

	// The menu is a popover in the top layer, placed under its trigger when it opens.
	function place() {
		if (!trigger || !menu) return;
		const box = trigger.getBoundingClientRect();
		const width = menu.offsetWidth;
		const left = align === 'end' ? box.right - width : box.left;
		const below = box.bottom + 6 + menu.offsetHeight <= window.innerHeight;
		menu.style.left = `${Math.max(8, Math.min(left, window.innerWidth - width - 8))}px`;
		menu.style.top = below
			? `${box.bottom + 6}px`
			: `${Math.max(8, box.top - 6 - menu.offsetHeight)}px`;
	}

	function toggled(event: ToggleEvent) {
		open = event.newState === 'open';
		if (!open) return;
		place();
		menu?.querySelector<HTMLElement>(`${itemRoles}:not([aria-disabled="true"])`)?.focus();
	}

	function keydown(event: KeyboardEvent) {
		if (!menu || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
		event.preventDefault();
		const entries = [...menu.querySelectorAll<HTMLElement>(itemRoles)];
		const index = entries.indexOf(document.activeElement as HTMLElement);
		const next =
			event.key === 'Home'
				? 0
				: event.key === 'End'
					? entries.length - 1
					: (index + (event.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length;
		entries[next]?.focus();
	}

	const itemRoles = '[role="menuitem"], [role="menuitemradio"]';

	function choose(item: MenuItem) {
		menu?.hidePopover();
		trigger?.focus();
		if ('onselect' in item) item.onselect();
	}
</script>

<button
	bind:this={trigger}
	type="button"
	class="trigger {className}"
	class:with-text={text}
	popovertarget={id}
	aria-haspopup="menu"
	aria-expanded={open}
	aria-label={text ? undefined : label}
	title={text ? undefined : label}
	>{#if lead}{@render lead()}{:else}<Glyph name={icon} size={20} />{/if}{#if text}<span class="text"
			>{text}</span
		><Glyph name={caret} size={16} />{/if}</button
>
<div
	bind:this={menu}
	{id}
	popover="auto"
	class="menu"
	role="menu"
	aria-label={label}
	tabindex="-1"
	ontoggle={toggled}
	onkeydown={keydown}
>
	{#if heading}<div class="heading">{@render heading()}</div>{/if}
	{#each items as item, index (index)}
		{#if 'divider' in item}
			<div role="separator" class="divider"></div>
		{:else if 'href' in item}
			<a
				role="menuitem"
				tabindex="-1"
				class:danger={item.danger}
				href={item.href}
				target={item.external ? '_blank' : undefined}
				rel={item.external ? 'noopener noreferrer' : undefined}
				onclick={() => menu?.hidePopover()}
				>{#if item.icon}<Glyph name={item.icon} size={18} />{/if}{item.label}</a
			>
		{:else}
			<button
				type="button"
				role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
				aria-checked={item.checked}
				tabindex="-1"
				class:danger={item.danger}
				aria-disabled={item.disabled || undefined}
				onclick={() => !item.disabled && choose(item)}
				>{#if item.icon}<Glyph name={item.icon} size={18} />{/if}<span class="label"
					>{item.label}</span
				>{#if item.detail}<span class="detail">{item.detail}</span
					>{/if}{#if item.checked !== undefined}<span class="check"
						>{#if item.checked}<Glyph name="check" size={16} />{/if}</span
					>{/if}</button
			>
		{/if}
	{/each}
</div>

<style>
	.trigger {
		display: inline-grid;
		flex: none;
		place-items: center;
		width: 2.25rem;
		height: 2.25rem;
		padding: 0;
		border: 1px solid transparent;
		border-radius: var(--radius-control, 0.5rem);
		background: transparent;
		color: var(--color-ink);
		cursor: pointer;
	}
	.trigger.with-text {
		display: flex;
		width: 100%;
		height: auto;
		min-height: 2.75rem;
		gap: 0.75rem;
		padding: 0 0.75rem;
		font: inherit;
		font-size: 0.9375rem;
		text-align: left;
	}
	.with-text .text {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.heading {
		padding: 0.5rem 0.65rem 0.65rem;
		margin-bottom: 0.25rem;
		border-bottom: 1px solid var(--color-rule);
	}
	.trigger:hover,
	.trigger[aria-expanded='true'] {
		background: var(--color-hover);
		color: var(--color-strong);
	}
	.menu {
		position: fixed;
		inset: auto;
		margin: 0;
		min-width: 12rem;
		padding: 0.375rem;
		border: 1px solid var(--color-rule);
		border-radius: var(--radius-md, 0.625rem);
		background: var(--color-paper);
		color: var(--color-ink);
		box-shadow: var(--shadow-float);
	}
	.menu:popover-open {
		display: grid;
		gap: 2px;
	}
	[role='menuitem'],
	[role='menuitemradio'] {
		display: flex;
		align-items: center;
		gap: 0.65rem;
		min-height: 2.5rem;
		padding: 0 0.65rem;
		border: 0;
		border-radius: var(--radius-sm, 0.375rem);
		background: transparent;
		color: var(--color-ink);
		font: inherit;
		font-size: 0.9375rem;
		text-align: left;
		text-decoration: none;
		cursor: pointer;
	}
	[role='menuitem']:hover,
	[role='menuitem']:focus-visible,
	[role='menuitemradio']:hover,
	[role='menuitemradio']:focus-visible {
		background: var(--color-hover);
		color: var(--color-strong);
		outline: none;
	}
	[role='menuitem'].danger {
		color: var(--color-danger);
	}
	[role='menuitem'][aria-disabled='true'] {
		color: var(--color-muted);
		cursor: not-allowed;
	}
	.label {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.detail {
		flex: none;
		color: var(--color-muted);
		font-size: 0.8125rem;
	}
	.check {
		display: inline-grid;
		flex: none;
		width: 1rem;
		color: var(--color-strong);
	}
	.divider {
		height: 1px;
		margin: 0.25rem 0;
		background: var(--color-rule);
	}
</style>
