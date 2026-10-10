<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts" module>
	export type BadgeTone = 'neutral' | 'accent' | 'positive' | 'warning' | 'danger' | 'info';
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import Glyph, { type GlyphName } from '../icons/Glyph.svelte';

	let {
		tone = 'neutral',
		icon,
		outlined = false,
		children
	}: { tone?: BadgeTone; icon?: GlyphName; outlined?: boolean; children: Snippet } = $props();
</script>

<span class="badge {tone}" class:outlined
	>{#if icon}<Glyph name={icon} size={14} />{/if}{@render children()}</span
>

<style>
	.badge {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		padding: 0.15rem 0.55rem;
		border: 1px solid transparent;
		border-radius: var(--radius-sm, 0.375rem);
		font-size: 0.8125rem;
		font-weight: 500;
		line-height: 1.4;
		white-space: nowrap;
	}
	.neutral {
		background: var(--color-selected);
		color: var(--color-ink);
	}
	.accent {
		background: var(--color-accent-soft);
		color: var(--color-accent-ink);
	}
	.positive {
		background: var(--color-positive-soft);
		color: var(--color-positive);
	}
	.warning {
		background: var(--color-warning-soft);
		color: var(--color-warning);
	}
	.danger {
		background: var(--color-danger-soft);
		color: var(--color-danger);
	}
	.info {
		background: var(--color-tile-blue-soft);
		color: var(--color-tile-blue);
	}
	.outlined {
		border-color: currentColor;
		border-radius: var(--radius-pill, 999px);
	}
	.outlined.neutral {
		border-color: var(--color-rule);
	}
</style>
