<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import type { ExportProgress } from '@flared/client/export';
	import { buildExport, buildLinksCsv, exportErrorMessage, ExportFailure } from './client';
	import SettingRow from '../molecules/SettingRow.svelte';
	import Button from '../atoms/Button.svelte';

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
	const files = $derived([
		{
			kind: 'csv' as const,
			icon: 'file' as const,
			title: 'Export links',
			description: 'Download your links as a spreadsheet.',
			label: 'Download CSV'
		},
		{
			kind: 'json' as const,
			icon: 'chart' as const,
			title: 'Export links and clicks',
			description: `Includes your links and ${history}.`,
			label: 'Download JSON'
		}
	]);

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
	<h3 id="export-heading" class="visually-hidden">Export your data</h3>
	{#each files as file (file.kind)}
		<SettingRow icon={file.icon} title={file.title} description={file.description}>
			{#if pending === file.kind}
				<Button onclick={() => controller?.abort()}>Cancel export</Button>
			{:else}
				<Button icon="download" disabled={pending !== null} onclick={() => void start(file.kind)}
					>{file.label}</Button
				>
			{/if}
		</SettingRow>
	{/each}
	<p class="status" role="status" aria-live="polite">
		{#if progress}Fetched {numbers.format(progress.links)} links and {numbers.format(
				progress.dailyTotals + progress.dailyDimensions
			)} analytics rows…{:else}{status}{/if}
	</p>
	{#if error}<p class="error" role="alert">{error}</p>{/if}
</section>

<style>
	.export {
		display: grid;
	}
	.status {
		padding-top: 0.6rem;
		color: var(--color-lead);
		font-size: 0.875rem;
	}
	.status:empty {
		display: none;
	}
	.error {
		padding-top: 0.6rem;
		color: var(--color-danger);
		font-size: 0.875rem;
	}
	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
</style>
