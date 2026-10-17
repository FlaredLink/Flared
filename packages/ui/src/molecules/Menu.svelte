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
				// Short text at the end of the item, such as a plan; under the label with detailBelow.
				detail?: string;
				// A small square before the label in place of the icon: a short text, such as a
				// workspace initial, or true to hold the icon.
				tile?: string | true;
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
		// Item details go under the label in place of the end of the item.
		detailBelow?: boolean;
		// A CSS width for the menu, such as "15.5rem"; without it the menu fits its items.
		width?: string;
		// 'top' opens the menu above its trigger when it fits there, such as at a sidebar foot.
		placement?: 'auto' | 'top';
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
		detailBelow = false,
		width,
		placement = 'auto',
		class: className = ''
	}: Props = $props();
	let trigger = $state<HTMLButtonElement>();
	let menu = $state<HTMLDivElement>();
	let open = $state(false);

	// The menu is a popover in the top layer, placed under its trigger when it opens, or above
	// it when there is no room under it or the placement is 'top'.
	function place() {
		if (!trigger || !menu) return;
		const box = trigger.getBoundingClientRect();
		const menuWidth = menu.offsetWidth;
		const left = align === 'end' ? box.right - menuWidth : box.left;
		const fitsBelow = box.bottom + 6 + menu.offsetHeight <= window.innerHeight;
		const fitsAbove = box.top - 6 - menu.offsetHeight >= 0;
		const below = placement === 'top' ? !fitsAbove && fitsBelow : fitsBelow;
		menu.style.left = `${Math.max(8, Math.min(left, window.innerWidth - menuWidth - 8))}px`;
		menu.style.top = below
			? `${box.bottom + 6}px`
			: `${Math.max(8, box.top - 6 - menu.offsetHeight)}px`;
		// The opening motion starts from the trigger's side.
		menu.dataset.side = below ? 'below' : 'above';
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
	class:turns={text && caret === 'caretDown'}
	popovertarget={id}
	aria-haspopup="menu"
	aria-expanded={open}
	aria-label={text ? undefined : label}
	title={text || lead ? undefined : label}
	>{#if lead}{@render lead()}{:else}<Glyph name={icon} size={20} />{/if}{#if text}<span class="text"
			>{text}</span
		><Glyph name={caret} size={16} />{/if}</button
>
<div
	bind:this={menu}
	{id}
	popover="auto"
	class="menu"
	style:width
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
				>{#if item.tile !== undefined}<span class="tile" aria-hidden="true"
						>{#if item.tile === true}{#if item.icon}<Glyph
									name={item.icon}
									size={14}
								/>{/if}{:else}{item.tile}{/if}</span
					>{:else if item.icon}<Glyph
						name={item.icon}
						size={18}
					/>{/if}{#if detailBelow && item.detail}<span class="lines"
						><span class="label">{item.label}</span><span class="detail">{item.detail}</span></span
					>{:else}<span class="label">{item.label}</span>{#if item.detail}<span class="detail"
							>{item.detail}</span
						>{/if}{/if}{#if item.checked !== undefined}<span class="check"
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
	/* Touch screens get a 44px target; the icon keeps its size. */
	@media (pointer: coarse) {
		.trigger:not(.with-text) {
			width: 2.75rem;
			height: 2.75rem;
		}
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
	/* A caller sets --menu-caret-color to mute the caret of a text trigger. */
	.with-text > :global(svg:last-child) {
		color: var(--menu-caret-color, currentColor);
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
		/* The gap stays outside :popover-open: the closing menu keeps its layout while it fades. */
		gap: 2px;
		/* Closing: the menu fades back toward its trigger, faster than it opens. overlay and display
		   keep it in the top layer until the fade ends. The ease-out curve fades it from the first
		   frame; --ease-in held it opaque, then cut it off at about 65%. */
		opacity: 0;
		transform: translateY(var(--menu-shift, -0.25rem)) scale(0.98);
		transform-origin: top;
		transition-property: opacity, transform, overlay, display;
		transition-duration: calc(var(--dur-fast) * 0.7);
		transition-timing-function: var(--ease-out);
		transition-behavior: allow-discrete;
	}
	.menu:popover-open {
		display: grid;
		opacity: 1;
		transform: none;
		transition-duration: var(--dur-fast);
		transition-timing-function: var(--ease-out);
	}
	@starting-style {
		.menu:popover-open {
			opacity: 0;
			transform: translateY(var(--menu-shift, -0.25rem)) scale(0.98);
		}
	}
	.menu:global([data-side='above']) {
		--menu-shift: 0.25rem;
		transform-origin: bottom;
	}
	.turns > :global(svg:last-child) {
		flex: none;
		transition: transform var(--dur-fast) var(--ease-out);
	}
	.turns[aria-expanded='true'] > :global(svg:last-child) {
		transform: rotate(180deg);
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
	.lines {
		display: grid;
		flex: 1;
		min-width: 0;
		padding-block: 0.375rem;
	}
	.lines .detail {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.tile {
		display: inline-grid;
		flex: none;
		place-items: center;
		width: 1.5rem;
		height: 1.5rem;
		border-radius: var(--radius-sm, 0.375rem);
		background: var(--color-selected);
		color: var(--color-strong);
		font-size: 0.6875rem;
		font-weight: 700;
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
