<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import Brand from './Brand.svelte';
	import SourceFooter from './SourceFooter.svelte';
	let { children }: { children: Snippet } = $props();
</script>

<div class="auth-frame">
	<header><span class="brand-link"><Brand /></span></header>
	<main id="main">{@render children()}</main>
	<SourceFooter />
</div>

<style>
	.auth-frame {
		min-height: 100svh;
		display: grid;
		grid-template-rows: auto 1fr auto;
		background: var(--color-surface);
	}
	header {
		padding: 1rem 1.5rem;
	}
	main {
		display: grid;
		place-items: center;
		padding: 2rem 1.25rem 4rem;
	}
</style>
