<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	let { small = false }: { small?: boolean } = $props();
</script>

<span class:small class="brand" role="img" aria-label="Flared"
	>flared<span class="brand-dot"></span></span
>

<style>
	.brand {
		display: inline-flex;
		align-items: baseline;
		font-size: 1.5rem;
		line-height: 1;
		color: var(--color-strong);
		font-family: var(--font-wordmark);
		font-weight: 700;
		letter-spacing: -0.03em;
	}
	.brand-dot {
		width: 0.2em;
		height: 0.2em;
		margin: 0 0.07em;
		border-radius: 50%;
		background: var(--color-button-primary);
	}
	.small {
		font-size: 1.1rem;
	}
</style>
