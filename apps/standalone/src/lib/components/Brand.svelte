<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	let { small = false }: { small?: boolean } = $props();
</script>

<span class:small class="brand" role="img" aria-label="Flared"
	><svg class="brand-mark" viewBox="0 0 64 64" aria-hidden="true"
		><g
			fill="none"
			stroke="currentColor"
			stroke-width="8"
			stroke-linecap="square"
			stroke-linejoin="round"
			><path d="M28 19H20L8 31V45H22L34 33V27" /><path d="M36 45H44L56 33V19H42L30 31V37" /></g
		></svg
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
	.brand-mark {
		align-self: center;
		width: 1em;
		height: 1em;
		margin-right: 0.3em;
		color: var(--color-button-primary);
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
