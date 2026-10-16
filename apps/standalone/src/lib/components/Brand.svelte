<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	let { small = false }: { small?: boolean } = $props();
</script>

<span class:small class="brand" role="img" aria-label="Flared"
	><svg class="brand-mark" viewBox="0 0 21 21" shape-rendering="crispEdges" aria-hidden="true"
		><path
			fill="currentColor"
			d="M13 0h4v1h-4zM11 1h8v1h-8zM10 2h3v1h-3zM17 2h3v1h-3zM10 3h2v1h-2zM18 3h2v1h-2zM9 4h2v1h-2zM19 4h2v1h-2zM9 5h2v1h-2zM19 5h2v1h-2zM9 6h2v1h-2zM19 6h2v1h-2zM9 7h2v1h-2zM19 7h2v1h-2zM10 8h2v1h-2zM18 8h2v1h-2zM4 9h4v1h-4zM10 9h3v1h-3zM17 9h3v1h-3zM2 10h17v1h-17zM1 11h3v1h-3zM8 11h3v1h-3zM13 11h4v1h-4zM1 12h2v1h-2zM9 12h2v1h-2zM0 13h2v1h-2zM10 13h2v1h-2zM0 14h2v1h-2zM10 14h2v1h-2zM0 15h2v1h-2zM10 15h2v1h-2zM0 16h2v1h-2zM10 16h2v1h-2zM1 17h2v1h-2zM9 17h2v1h-2zM1 18h3v1h-3zM8 18h3v1h-3zM2 19h8v1h-8zM4 20h4v1h-4z"
		/></svg
	>flared</span
>

<style>
	.brand {
		display: inline-flex;
		align-items: center;
		gap: 0.35em;
		font-size: 1.5rem;
		line-height: 1;
		color: var(--color-strong);
		font-family: var(--font-wordmark);
		font-weight: 700;
		letter-spacing: -0.02em;
	}
	/* The mark is drawn on a 21-unit pixel grid; a whole multiple of 21 px keeps its edges sharp. */
	.brand-mark {
		flex: none;
		width: 21px;
		height: 21px;
	}
	.small {
		font-size: 1.1rem;
	}
</style>
