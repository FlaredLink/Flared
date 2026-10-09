<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import type { ExportProgress } from '@flared/client/export';
	import { buildExport, buildLinksCsv, exportErrorMessage, ExportFailure } from './client';
	import Panel from '../layout/Panel.svelte';
	import Tile from '../layout/Tile.svelte';

	interface Props {
		// The path of the /v1 API for this browser, such as "/api/v1".
		apiBase: string;
		// Days of click history the workspace keeps, shown in the description.
		retentionDays: number | null;
	}

	let { apiBase, retentionDays }: Props = $props();

	let pending = $state<'json' | 'csv' | null>(null);
	let progress = $state<ExportProgress | null>(null);
	let status = $state('');
	let error = $state('');
	let controller: AbortController | null = null;

	const numbers = new Intl.NumberFormat();
	const history = $derived(
		retentionDays === null ? 'the click history you still have' : `${retentionDays} days of clicks`
	);

	function save(blob: Blob, filename: string) {
		const href = URL.createObjectURL(blob);
		const anchor = document.createElement('a');
		anchor.href = href;
		anchor.download = filename;
		anchor.click();
		setTimeout(() => URL.revokeObjectURL(href), 60_000);
	}

	async function start(kind: 'json' | 'csv') {
		controller = new AbortController();
		pending = kind;
		progress = null;
		status = 'Preparing your export…';
		error = '';
		try {
			const build = kind === 'json' ? buildExport : buildLinksCsv;
			const file = await build(apiBase, controller.signal, (next) => (progress = next));
			save(file.blob, file.filename);
			const counts = file.counts;
			status =
				kind === 'json'
					? `Downloaded ${numbers.format(counts.links)} links and ${numbers.format(counts.dailyTotals + counts.dailyDimensions)} analytics rows.`
					: `Downloaded ${numbers.format(counts.links)} links.`;
		} catch (caught) {
			status = '';
			if (controller.signal.aborted) status = 'Export canceled.';
			else error = exportErrorMessage(caught instanceof ExportFailure ? caught.code : null);
		} finally {
			pending = null;
			progress = null;
			controller = null;
		}
	}
</script>

<Panel
	id="export-heading"
	title="Export your data"
	lead="Download your links and {history}. The file is built in this browser."
	icon="download"
	tone="blue"
>
	<ul>
		<li>
			<Tile icon="file" />
			<div class="main">
				<span class="name">Links</span>
				<span class="meta">CSV spreadsheet</span>
			</div>
			{#if pending === 'csv'}
				<button type="button" class="quiet" onclick={() => controller?.abort()}
					>Cancel export</button
				>
			{:else}
				<button
					type="button"
					class="quiet"
					disabled={pending !== null}
					onclick={() => void start('csv')}>Download CSV</button
				>
			{/if}
		</li>
		<li>
			<Tile icon="code" />
			<div class="main">
				<span class="name">Links and clicks</span>
				<span class="meta">JSON file</span>
			</div>
			{#if pending === 'json'}
				<button type="button" class="quiet" onclick={() => controller?.abort()}
					>Cancel export</button
				>
			{:else}
				<button
					type="button"
					class="quiet"
					disabled={pending !== null}
					onclick={() => void start('json')}>Download JSON</button
				>
			{/if}
		</li>
	</ul>
	<p class="status" role="status" aria-live="polite">
		{#if progress}Fetched {numbers.format(progress.links)} links and {numbers.format(
				progress.dailyTotals + progress.dailyDimensions
			)} analytics rows…{:else}{status}{/if}
	</p>
	{#if error}<p class="error" role="alert">{error}</p>{/if}
</Panel>

<style>
	ul {
		display: grid;
		margin: 0;
		padding: 0;
		list-style: none;
		border-top: 1px solid var(--color-rule, #eaecf0);
	}
	li {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.75rem 1rem;
		padding: 0.9rem 0;
	}
	li + li {
		border-top: 1px solid var(--color-rule, #eaecf0);
	}
	.main {
		display: grid;
		flex: 1 1 10rem;
		gap: 0.15rem;
		min-width: 0;
	}
	.name {
		color: var(--color-strong, #101828);
		font-weight: 650;
	}
	.meta,
	.status {
		color: var(--color-muted, #667085);
		font-size: 0.85rem;
	}
	.status:empty {
		display: none;
	}
	.error {
		color: var(--color-danger, #b42318);
		font-size: 0.85rem;
	}
	button {
		min-height: 44px;
		padding: 0.6rem 1.15rem;
		border: 1px solid var(--color-rule, #d0d5dd);
		border-radius: var(--radius-sm, 6px);
		background: var(--color-paper, #fff);
		color: var(--color-ink, #101828);
		font-weight: 620;
	}
	button:hover:not(:disabled) {
		background: var(--color-surface, #f9fafb);
		border-color: var(--color-muted, #667085);
	}
	button:disabled {
		color: var(--color-muted, #667085);
		background: var(--color-disabled, #eaecf0);
		border-color: var(--color-disabled, #eaecf0);
	}
</style>
