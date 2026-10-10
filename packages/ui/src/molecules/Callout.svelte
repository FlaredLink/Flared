<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import Glyph, { type GlyphName } from '../icons/Glyph.svelte';

	type Tone = 'neutral' | 'info' | 'positive' | 'warning' | 'danger';
	interface Props {
		tone?: Tone;
		icon?: GlyphName;
		title?: string;
		// Alerts announce themselves; the rest stay quiet.
		role?: 'alert' | 'status';
		children: Snippet;
	}
	let { tone = 'neutral', icon, title, role, children }: Props = $props();
	const icons: Record<Tone, GlyphName> = {
		neutral: 'info',
		info: 'info',
		positive: 'checkCircle',
		warning: 'warningCircle',
		danger: 'warning'
	};
</script>

<div class="callout {tone}" {role}>
	<span class="icon"><Glyph name={icon ?? icons[tone]} size={20} /></span>
	<div class="text">
		{#if title}<p class="title">{title}</p>{/if}
		<div class="body">{@render children()}</div>
	</div>
</div>

<style>
	.callout {
		display: flex;
		align-items: flex-start;
		gap: 0.75rem;
		padding: 0.85rem 1rem;
		border: 1px solid var(--color-rule);
		border-radius: var(--radius-md, 0.625rem);
		background: var(--color-paper);
		color: var(--color-ink);
		font-size: 0.9375rem;
	}
	.icon {
		display: grid;
		margin-top: 0.1rem;
		color: var(--color-lead);
	}
	.text {
		display: grid;
		gap: 0.2rem;
		min-width: 0;
	}
	.title {
		color: var(--color-strong);
		font-weight: 600;
	}
	.body :global(p) {
		color: inherit;
	}
	.body :global(a) {
		color: var(--color-link);
		text-decoration: underline;
		text-underline-offset: 3px;
	}
	.info .icon {
		color: var(--color-tile-blue);
	}
	.positive {
		border-color: color-mix(in oklch, var(--color-positive) 30%, transparent);
		background: var(--color-positive-soft);
	}
	.positive .icon {
		color: var(--color-positive);
	}
	.warning {
		border-color: color-mix(in oklch, var(--color-warning) 30%, transparent);
		background: var(--color-warning-soft);
	}
	.warning .icon {
		color: var(--color-warning);
	}
	.danger {
		border-color: color-mix(in oklch, var(--color-danger) 30%, transparent);
		background: var(--color-danger-soft);
	}
	.danger .icon {
		color: var(--color-danger);
	}
</style>
