<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts" module>
	// The QR code route of one link, such as "/api/v1/links/abc/qr".
	export function qrAddress(apiBase: string, linkId: string): string {
		return `${apiBase}/links/${encodeURIComponent(linkId)}/qr`;
	}

	// Copies the PNG where the browser allows images on the clipboard, and returns the message to
	// announce.
	export async function copyQrImage(qr: string): Promise<string> {
		try {
			const response = await fetch(`${qr}?format=png&size=1024`);
			if (!response.ok) throw new Error('qr');
			const blob = await response.blob();
			await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
			return 'QR code copied.';
		} catch {
			return 'This browser cannot copy images. Download the QR code instead.';
		}
	}
</script>

<script lang="ts">
	import type { Link } from '@flared/contracts/links';
	import Button from '../atoms/Button.svelte';
	import CopyButton from '../molecules/CopyButton.svelte';
	import SegmentedControl from '../molecules/SegmentedControl.svelte';

	interface Props {
		// The path of the /v1 API for this browser, such as "/api/v1".
		apiBase: string;
		link: Pick<Link, 'id' | 'hostname' | 'slug' | 'shortUrl'>;
	}

	let { apiBase, link }: Props = $props();
	const id = $props.id();

	let failed = $state(false);
	let format = $state('png');
	let copyStatus = $state('');
	const qr = $derived(qrAddress(apiBase, link.id));
	const shortName = $derived(`${link.hostname}/${link.slug}`);
	const download = $derived(
		format === 'svg' ? `${qr}?format=svg&download=1` : `${qr}?format=png&size=1024&download=1`
	);

	async function copyImage() {
		copyStatus = await copyQrImage(qr);
	}
</script>

<section class="qr" aria-labelledby="{id}-heading">
	<h2 id="{id}-heading" class="visually-hidden">QR code</h2>
	<div class="layout">
		<figure class="card">
			{#if failed}
				<p class="error" role="alert">The QR code could not load. Refresh the page to try again.</p>
			{:else}
				<img
					src="{qr}?format=svg"
					alt="QR code for {shortName}"
					width="220"
					height="220"
					onerror={() => (failed = true)}
				/>
			{/if}
			<figcaption>{shortName}</figcaption>
		</figure>
		<div class="side">
			<div class="field">
				<span class="label" aria-hidden="true">Format</span>
				<SegmentedControl
					options={[
						{ value: 'png', label: 'PNG' },
						{ value: 'svg', label: 'SVG' }
					]}
					bind:value={format}
					name="{id}-format"
					label="Format"
					wide
				/>
			</div>
			<Button variant="primary" icon="download" href={download} download wide
				>Download {format.toUpperCase()}</Button
			>
			<div class="copies">
				<Button icon="copy" onclick={() => void copyImage()}>Copy image</Button>
				<CopyButton text={link.shortUrl} label="Copy link" kind="button" />
			</div>
			<p class="copy-status" role="status">{copyStatus}</p>
			<p class="note">
				The code opens the short link, so printed codes keep working when you change the
				destination.
			</p>
		</div>
	</div>
</section>

<style>
	.qr {
		container-type: inline-size;
	}
	.layout {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 1.5rem;
		align-items: center;
	}
	/* White in both themes: scanners need dark modules on a light ground. */
	.card {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.875rem;
		justify-self: center;
		margin: 0;
		padding: 1.5rem;
		border-radius: 1.25rem;
		background: #fff;
		box-shadow:
			0 0 0 1px rgb(10 10 10 / 0.08),
			0 20px 40px -24px rgb(10 10 10 / 0.35);
		color: #0a0a0a;
	}
	img {
		display: block;
		width: 13.75rem;
		height: 13.75rem;
	}
	figcaption {
		font-family: var(--font-mono);
		font-size: 0.8125rem;
		overflow-wrap: anywhere;
		text-align: center;
	}
	/* The light-theme danger red: the card stays white in the dark theme too. */
	.error {
		display: grid;
		place-items: center;
		width: 13.75rem;
		height: 13.75rem;
		color: #b42318;
		font-size: 0.875rem;
		text-align: center;
	}
	.side {
		display: grid;
		gap: 1rem;
		width: 100%;
		max-width: 22rem;
		justify-self: center;
	}
	.field {
		display: grid;
		gap: 0.375rem;
	}
	.label {
		color: var(--color-subtle);
		font-size: 0.75rem;
	}
	.copies {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.625rem;
	}
	.copy-status:empty {
		display: none;
	}
	.copy-status,
	.note {
		color: var(--color-muted);
		font-size: 0.875rem;
		line-height: 1.6;
	}
	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
	/* The code and its controls side by side. */
	@container (min-width: 40rem) {
		.layout {
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: 2rem;
			padding: 1rem 0;
		}
		.side {
			justify-self: start;
		}
	}
</style>
