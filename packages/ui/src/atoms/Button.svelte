<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts" module>
	export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-soft' | 'link';
	export type ButtonSize = 'sm' | 'md' | 'lg';
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLAnchorAttributes, HTMLButtonAttributes } from 'svelte/elements';
	import Glyph, { type GlyphName } from '../icons/Glyph.svelte';

	type Common = {
		variant?: ButtonVariant;
		size?: ButtonSize;
		// A Glyph before the label and one after it, such as an arrow.
		icon?: GlyphName;
		trailing?: GlyphName;
		wide?: boolean;
		children?: Snippet;
	};
	type Props = Common &
		((HTMLButtonAttributes & { href?: undefined }) | (HTMLAnchorAttributes & { href: string }));

	let {
		variant = 'secondary',
		size = 'md',
		icon,
		trailing,
		wide = false,
		children,
		class: className = '',
		...rest
	}: Props = $props();
	const glyphSize = $derived(size === 'sm' ? 16 : 18);
</script>

{#snippet content()}
	{#if icon}<Glyph name={icon} size={glyphSize} />{/if}
	{#if children}<span class="label">{@render children()}</span>{/if}
	{#if trailing}<Glyph name={trailing} size={glyphSize} />{/if}
{/snippet}

{#if rest.href !== undefined}
	<a class="button {variant} {size} {className}" class:wide {...rest as HTMLAnchorAttributes}
		>{@render content()}</a
	>
{:else}
	<button
		type="button"
		class="button {variant} {size} {className}"
		class:wide
		{...rest as HTMLButtonAttributes}>{@render content()}</button
	>
{/if}

<style>
	.button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		min-width: 0;
		border: 0;
		border-radius: var(--radius-control, 0.5rem);
		font: inherit;
		font-weight: 500;
		line-height: 1.2;
		text-decoration: none;
		white-space: nowrap;
		cursor: pointer;
		transition:
			background var(--dur-fast, 140ms) var(--ease-out, ease),
			color var(--dur-fast, 140ms) var(--ease-out, ease),
			opacity var(--dur-fast, 140ms) var(--ease-out, ease);
	}
	.label {
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.sm {
		min-height: 2.25rem;
		padding: 0 0.75rem;
		font-size: 0.875rem;
	}
	/* Touch screens get a 44px target. */
	@media (pointer: coarse) {
		.sm {
			min-height: 2.75rem;
		}
	}
	.md {
		min-height: 2.75rem;
		padding: 0 1.125rem;
		font-size: 0.9375rem;
	}
	.lg {
		min-height: 3.25rem;
		padding: 0 1.5rem;
		font-size: 1rem;
	}
	.wide {
		width: 100%;
	}
	.primary {
		background: var(--color-button-primary);
		color: var(--color-on-primary);
	}
	.primary:hover {
		opacity: 0.86;
	}
	.secondary {
		background: var(--color-surface);
		box-shadow: var(--shadow-ring);
		color: var(--color-strong);
	}
	.secondary:hover {
		background: var(--color-surface-2);
	}
	.ghost {
		background: transparent;
		color: var(--color-ink);
	}
	.ghost:hover {
		background: var(--color-hover);
		color: var(--color-strong);
	}
	.danger {
		background: var(--color-surface);
		box-shadow: var(--shadow-ring);
		color: var(--color-danger);
	}
	.danger:hover {
		background: var(--color-danger-soft);
	}
	.danger-soft {
		background: var(--color-danger-soft);
		color: var(--color-danger);
	}
	.danger-soft:hover {
		box-shadow: 0 0 0 1px color-mix(in oklch, var(--color-danger) 40%, transparent);
	}
	.link {
		min-height: 2.75rem;
		padding: 0;
		background: transparent;
		color: var(--color-link);
	}
	.link .label {
		text-decoration: underline;
		text-decoration-color: var(--color-faint);
		text-underline-offset: 3px;
	}
	.link:hover .label {
		text-decoration-color: currentColor;
	}
	/* Disabled buttons keep solid neutral colours, so the label stays readable. */
	.button:disabled,
	.button[aria-disabled='true'] {
		background: var(--color-disabled);
		box-shadow: none;
		color: var(--color-subtle);
		cursor: not-allowed;
		opacity: 1;
	}
	.link:disabled,
	.ghost:disabled,
	.ghost[aria-disabled='true'] {
		background: transparent;
	}
	.button:active:not(:disabled) {
		transform: translateY(1px);
	}
</style>
