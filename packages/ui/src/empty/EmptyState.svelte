<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import type { Snippet } from 'svelte';

	let { children }: { children: Snippet } = $props();
</script>

<!-- A chain link that sends out a spark: neutral lines, one orange accent on a peach disc. -->
<div class="empty-state">
	<svg viewBox="0 0 96 72" aria-hidden="true">
		<circle class="disc" cx="66" cy="24" r="17" />
		<g class="link">
			<rect x="10" y="34" width="34" height="18" rx="9" transform="rotate(-30 27 43)" />
			<rect x="32" y="22" width="34" height="18" rx="9" transform="rotate(-30 49 31)" />
		</g>
		<path class="spark" d="M66 11l3 10 10 3-10 3-3 10-3-10-10-3 10-3z" />
		<path class="ray" d="M84 10l-4 4M88 26h-5M48 8l3 4" />
	</svg>
	<p>{@render children()}</p>
</div>

<style>
	.empty-state {
		display: grid;
		justify-items: center;
		gap: 0.6rem;
		padding: 1.75rem 1rem;
		text-align: center;
	}
	svg {
		width: 6rem;
		height: 4.5rem;
	}
	.disc {
		fill: var(--color-accent-soft, #fff4ed);
	}
	.link {
		fill: none;
		stroke: var(--color-muted, #667085);
		stroke-width: 3;
	}
	.spark {
		fill: var(--color-button-primary, #c94b00);
	}
	.ray {
		fill: none;
		stroke: var(--color-button-primary, #c94b00);
		stroke-width: 2.5;
		stroke-linecap: round;
	}
	p {
		max-width: 28rem;
		margin: 0;
		color: var(--color-muted, #667085);
		font-size: 0.875rem;
	}
</style>
