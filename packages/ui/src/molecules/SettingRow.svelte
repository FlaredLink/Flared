<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import Glyph, { type GlyphName } from '../icons/Glyph.svelte';

	interface Props {
		icon?: GlyphName;
		title: string;
		description?: string;
		// The heading's id, when a control is labelled by it.
		id?: string;
		danger?: boolean;
		// The value or control on the right.
		children?: Snippet;
	}
	let { icon, title, description, id, danger = false, children }: Props = $props();
</script>

<div class="setting-row" class:danger class:plain={!icon}>
	{#if icon}<span class="icon"><Glyph name={icon} size={24} /></span>{/if}
	<div class="text">
		<h3 {id}>{title}</h3>
		{#if description}<p>{description}</p>{/if}
	</div>
	{#if children}<div class="control">{@render children()}</div>{/if}
</div>

<style>
	.setting-row {
		display: grid;
		grid-template-columns: 2.25rem minmax(0, 1fr);
		gap: 0.25rem 1rem;
		align-items: start;
		padding: 1rem 0;
		border-bottom: 1px solid var(--color-rule);
	}
	.icon {
		display: grid;
		align-self: start;
		margin-top: 0.1rem;
		color: var(--color-ink);
	}
	.danger .icon {
		color: var(--color-danger);
	}
	h3 {
		color: var(--color-strong);
		font-size: 1rem;
		font-weight: 600;
		letter-spacing: -0.01em;
	}
	p {
		color: var(--color-lead);
		font-size: 0.9375rem;
	}
	.control {
		grid-column: 2;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.75rem;
		min-width: 0;
		margin-top: 0.5rem;
	}
	.plain {
		grid-template-columns: minmax(0, 1fr);
	}
	.plain .control {
		grid-column: 1;
	}
	@media (min-width: 52rem) {
		.setting-row {
			grid-template-columns: 2.25rem minmax(0, 1fr) minmax(0, 1.25fr);
		}
		.plain {
			grid-template-columns: minmax(0, 1fr) minmax(0, 1.25fr);
		}
		.control {
			grid-column: 3;
			justify-content: flex-end;
			margin-top: 0;
		}
		.plain .control {
			grid-column: 2;
		}
	}
</style>
