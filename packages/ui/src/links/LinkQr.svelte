<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	interface Props {
		// The path of the /v1 API for this browser, such as "/api/v1".
		apiBase: string;
		linkId: string;
		shortUrl: string;
	}

	let { apiBase, linkId, shortUrl }: Props = $props();

	let failed = $state(false);
	const base = $derived(`${apiBase}/links/${encodeURIComponent(linkId)}/qr`);
	const shortName = $derived(shortUrl.replace(/^https?:\/\//, ''));
</script>

<section class="qr" aria-labelledby="link-qr-heading">
	<div class="preview">
		{#if failed}
			<p class="error" role="alert">The QR code could not load. Refresh the page to try again.</p>
		{:else}
			<img
				src={base}
				alt={`QR code for ${shortName}`}
				width="160"
				height="160"
				onerror={() => (failed = true)}
			/>
		{/if}
	</div>
	<div class="body">
		<h2 id="link-qr-heading">QR code</h2>
		<p class="lead">
			Scanning it opens {shortName}. It stays the same if you change the destination.
		</p>
		<div class="actions">
			<a class="button" href={`${base}?format=svg&download=1`} download>Download SVG</a>
			<a class="button" href={`${base}?format=png&size=1024&download=1`} download>Download PNG</a>
		</div>
	</div>
</section>

<style>
	.qr {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 1.25rem;
		max-width: 44rem;
		padding: 1rem;
		border: 1px solid var(--color-rule, #d0d5dd);
		border-radius: var(--radius-md, 8px);
		background: var(--color-paper, #fff);
	}
	.preview {
		display: grid;
		place-items: center;
		flex: none;
		width: 160px;
		height: 160px;
		border-radius: var(--radius-sm, 6px);
		background: #fff;
	}
	img {
		display: block;
		width: 160px;
		height: 160px;
	}
	.body {
		display: grid;
		flex: 1 1 16rem;
		gap: 0.5rem;
		min-width: 0;
	}
	h2 {
		font-size: 1.05rem;
	}
	.lead {
		color: var(--color-muted, #667085);
		font-size: 0.85rem;
	}
	.error {
		padding: 0.75rem;
		color: var(--color-danger, #b42318);
		font-size: 0.8rem;
		text-align: center;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}
	.button {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		padding: 0.4rem 0.9rem;
		border: 1px solid var(--color-rule, #d0d5dd);
		border-radius: var(--radius-sm, 6px);
		background: var(--color-paper, #fff);
		color: var(--color-ink, #101828);
		font-size: 0.85rem;
		font-weight: 600;
		text-decoration: none;
	}
	.button:hover {
		border-color: var(--color-muted, #667085);
	}
</style>
