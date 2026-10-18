<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts" module>
	export type StatusTone = 'live' | 'warning' | 'danger' | 'neutral';
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';

	// The text carries the state; the dot repeats it in colour.
	let { tone = 'live', children }: { tone?: StatusTone; children: Snippet } = $props();
</script>

<span class="status {tone}"><span class="dot" aria-hidden="true"></span>{@render children()}</span>

<style>
	.status {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		color: var(--color-live);
		font-size: 0.9375rem;
		font-weight: 500;
		white-space: nowrap;
	}
	.dot {
		width: 0.45rem;
		height: 0.45rem;
		flex: none;
		border-radius: 50%;
		background: currentColor;
	}
	.warning {
		color: var(--color-warning);
	}
	.danger {
		color: var(--color-danger);
	}
	.neutral {
		color: var(--color-subtle);
	}
</style>
