<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	// A site's icon in a square tile, or the first letter of its host name when the app has no
	// icon route or the site has no icon.
	interface Props {
		hostname: string;
		// The icon's address on the app's own origin, or null for the letter only.
		src: string | null;
		// The tile's edge in pixels; the icon is a little more than half of it.
		size?: number;
	}

	let { hostname, src, size = 32 }: Props = $props();
	// The address that failed to load; a new address gets a new attempt.
	let failedSrc = $state<string | null>(null);
	const letter = $derived(hostname.charAt(0).toUpperCase());
</script>

<span
	class="site-icon"
	style:--size={`${size}px`}
	style:--glyph={`${Math.round(size * 0.6)}px`}
	aria-hidden="true"
>
	{#if src && src !== failedSrc}
		<img
			{src}
			alt=""
			width={Math.round(size * 0.6)}
			height={Math.round(size * 0.6)}
			loading="lazy"
			decoding="async"
			onerror={() => (failedSrc = src)}
		/>
	{:else}
		<span class="letter">{letter}</span>
	{/if}
</span>

<style>
	.site-icon {
		display: inline-flex;
		flex: none;
		align-items: center;
		justify-content: center;
		width: var(--size);
		height: var(--size);
		border: 1px solid var(--color-rule, #d0d5dd);
		border-radius: calc(var(--size) / 4);
		background: var(--color-surface, #fff);
	}
	img {
		display: block;
		width: var(--glyph);
		height: var(--glyph);
		object-fit: contain;
	}
	.letter {
		color: var(--color-muted, #667085);
		font-size: calc(var(--size) * 0.45);
		font-weight: 650;
		line-height: 1;
	}
</style>
