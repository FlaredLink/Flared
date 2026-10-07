<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import type { ExportProgress } from '@flared/client/export';
	import { buildExport, buildLinksCsv, exportErrorMessage, ExportFailure } from './client';

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

<section class="export" aria-labelledby="export-heading">
	<h2 id="export-heading">Export your data</h2>
	<p class="lead">
		Download every link and {history} as one JSON file, or only the links as CSV for a spreadsheet. The
		file is built in this browser.
	</p>
	<p class="status" role="status" aria-live="polite">
		{#if progress}Fetched {numbers.format(progress.links)} links and {numbers.format(
				progress.dailyTotals + progress.dailyDimensions
			)} analytics rows…{:else}{status}{/if}
	</p>
	{#if error}<p class="error" role="alert">{error}</p>{/if}
	<div class="actions">
		{#if pending}
			<button type="button" class="quiet" onclick={() => controller?.abort()}>Cancel export</button>
		{:else}
			<button type="button" onclick={() => void start('json')}>Download JSON</button>
			<button type="button" class="quiet" onclick={() => void start('csv')}
				>Download links as CSV</button
			>
		{/if}
	</div>
</section>

<style>
	.export {
		display: grid;
		gap: 0.75rem;
		max-width: 44rem;
	}
	h2 {
		font-size: 1.05rem;
	}
	.lead,
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
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}
	button {
		min-height: 44px;
		padding: 0.65rem 1.15rem;
		border: 1px solid var(--color-button-primary, #101828);
		border-radius: var(--radius-sm, 6px);
		background: var(--color-button-primary, #101828);
		color: var(--color-on-primary, #fff);
		font-weight: 620;
	}
	button:hover {
		background: var(--color-button-primary-hover, #344054);
		border-color: var(--color-button-primary-hover, #344054);
	}
	button.quiet {
		border-color: var(--color-rule, #d0d5dd);
		background: var(--color-paper, #fff);
		color: var(--color-ink, #101828);
	}
	button.quiet:hover {
		background: var(--color-surface, #f9fafb);
		border-color: var(--color-muted, #667085);
	}
</style>
