<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts" module>
	export type TileTone = 'neutral' | 'accent' | 'blue' | 'violet' | 'teal' | 'charcoal' | 'danger';
</script>

<script lang="ts">
	import Glyph, { type GlyphName } from '../icons/Glyph.svelte';

	let {
		icon,
		tone = 'neutral',
		large = false
	}: { icon: GlyphName; tone?: TileTone; large?: boolean } = $props();
</script>

<span class="tile {tone}" class:large aria-hidden="true"
	><Glyph name={icon} size={large ? 26 : 22} /></span
>

<style>
	/* One colour per kind of thing; the cards around the tiles stay neutral. */
	.tile {
		display: inline-grid;
		flex: none;
		place-items: center;
		width: 2.5rem;
		height: 2.5rem;
		border-radius: var(--radius-md, 8px);
		background: var(--color-disabled, #f2f4f7);
		color: var(--color-ink, #101828);
	}
	.large {
		width: 3rem;
		height: 3rem;
	}
	.accent {
		background: var(--color-accent-soft, #fff4ed);
		color: var(--color-accent-ink, #b93815);
	}
	.blue {
		background: var(--color-tile-blue-soft, #eff8ff);
		color: var(--color-tile-blue, #175cd3);
	}
	.violet {
		background: var(--color-tile-violet-soft, #f4f3ff);
		color: var(--color-tile-violet, #6938ef);
	}
	.teal {
		background: var(--color-tile-teal-soft, #f0fdf9);
		color: var(--color-tile-teal, #107569);
	}
	.charcoal {
		background: var(--color-tile-charcoal, #344054);
		color: var(--color-tile-charcoal-icon, #fff);
	}
	.danger {
		background: var(--color-danger-soft, #fef3f2);
		color: var(--color-danger, #b42318);
	}
</style>
