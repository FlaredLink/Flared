<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import { qrPng, qrSvg } from '@flared/client/qr';
	import Button from '../atoms/Button.svelte';
	import CopyButton from '../molecules/CopyButton.svelte';
	import SegmentedControl from '../molecules/SegmentedControl.svelte';

	interface Props {
		// The page's address, such as https://name.flared.site.
		address: string;
		// The file name without the extension.
		fileName: string;
	}

	let { address, fileName }: Props = $props();
	const id = $props.id();

	let format = $state('png');
	let copyStatus = $state('');
	const shown = $derived(address.replace(/^https:\/\//, ''));
	const svg = $derived(qrSvg(address, 220));

	async function pngBlob(): Promise<Blob> {
		const bytes = await qrPng(address, 1024);
		return new Blob([new Uint8Array(bytes)], { type: 'image/png' });
	}

	async function download() {
		const blob =
			format === 'svg'
				? new Blob([qrSvg(address, 1024)], { type: 'image/svg+xml' })
				: await pngBlob();
		const url = URL.createObjectURL(blob);
		const link = document.createElement('a');
		link.href = url;
		link.download = `${fileName}.${format}`;
		link.click();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	}

	async function copyImage() {
		try {
			const blob = await pngBlob();
			await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
			copyStatus = 'QR code copied.';
		} catch {
			copyStatus = 'This browser cannot copy images. Download the QR code instead.';
		}
	}
</script>

<section class="qr" aria-labelledby="{id}-heading">
	<h2 id="{id}-heading" class="visually-hidden">QR code</h2>
	<div class="layout">
		<figure class="card">
			<img
				src="data:image/svg+xml;charset=utf-8,{encodeURIComponent(svg)}"
				alt="QR code for {shown}"
				width="220"
				height="220"
			/>
			<figcaption>{shown}</figcaption>
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
			<Button variant="primary" icon="download" wide onclick={() => void download()}
				>Download {format.toUpperCase()}</Button
			>
			<Button icon="image" wide onclick={() => void copyImage()}>Copy image</Button>
			<CopyButton text={address} label="Copy page address" kind="button" wide />
			<p class="status" role="status" aria-live="polite">{copyStatus}</p>
			<p class="hint">The code opens the page address. It keeps working after you edit the page.</p>
		</div>
	</div>
</section>

<style>
	.qr {
		width: min(100%, 44rem);
	}
	.layout {
		display: grid;
		gap: 1.25rem;
	}
	.card {
		display: grid;
		justify-items: center;
		gap: 0.75rem;
		margin: 0;
		padding: 1.5rem;
		border-radius: 0.875rem;
		background: var(--color-surface);
		box-shadow: var(--shadow-ring);
	}
	figcaption {
		color: var(--color-muted);
		font-family: var(--font-mono);
		font-size: 0.8125rem;
		overflow-wrap: anywhere;
	}
	.side {
		display: grid;
		align-content: start;
		gap: 0.625rem;
	}
	.field {
		display: grid;
		gap: 0.375rem;
	}
	.label {
		color: var(--color-strong);
		font-size: 0.875rem;
		font-weight: 500;
	}
	.status {
		color: var(--color-muted);
		font-size: 0.875rem;
	}
	.status:empty {
		display: none;
	}
	.hint {
		color: var(--color-lead);
		font-size: 0.8125rem;
	}
	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
	@media (min-width: 40rem) {
		.layout {
			grid-template-columns: auto minmax(0, 1fr);
			align-items: start;
		}
	}
</style>
