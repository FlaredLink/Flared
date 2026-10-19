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
		/* A list can set --site-icon-size to change the tile by width. */
		--edge: var(--site-icon-size, var(--size));
		width: var(--edge);
		height: var(--edge);
		border-radius: calc(var(--edge) * 0.28);
		background: var(--color-surface-3, #ececee);
	}
	img {
		display: block;
		width: var(--glyph);
		height: var(--glyph);
		object-fit: contain;
	}
	.letter {
		color: var(--color-muted, #52525b);
		font-size: calc(var(--edge) * 0.4);
		font-weight: 600;
		line-height: 1;
	}
</style>
