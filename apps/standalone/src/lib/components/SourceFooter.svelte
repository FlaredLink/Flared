<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import { page } from '$app/state';
	import { sourceLink } from '$lib/source';

	const href = $derived(sourceLink(page.data.sourceUrl, __FLARED_COMMIT__));
</script>

<footer class="source-footer">
	<span>Flared is open source under the AGPL.</span>
	<a {href} rel="noopener">Source code</a>
</footer>

<style>
	.source-footer {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: 0.25rem 1rem;
		padding: 1.5rem;
		color: var(--color-muted);
		font-size: 0.8rem;
	}
	a {
		color: var(--color-accent-ink);
		font-weight: 600;
	}
</style>
