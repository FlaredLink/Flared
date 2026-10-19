<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import type { ImportLinksResult } from '@flared/contracts/links';
	import {
		failedRowsCsv,
		fileKind,
		fileSizeProblem,
		guessColumns,
		ImportFileError,
		planImport,
		readImportFile,
		rowsFromCsv,
		type CsvColumns,
		type ImportDomain,
		type ImportFile,
		type ImportItemInput,
		type ImportPlan,
		type ImportRow,
		type ShortColumns
	} from './import-file';
	import {
		importItemReason,
		importStopReason,
		runImportChunks,
		type ChunkRunEnd
	} from './import-client';
	import { shownWorkspace } from '../workspace/shown';
	import Button from '../atoms/Button.svelte';
	import Checkbox from '../atoms/Checkbox.svelte';
	import Select from '../atoms/Select.svelte';
	import Callout from '../molecules/Callout.svelte';
	import Dialog from '../molecules/Dialog.svelte';
	import FormField from '../molecules/FormField.svelte';

	interface Props {
		open: boolean;
		onclose?: () => void;
		// The path of the /v1 API for this browser, such as "/api/v1".
		apiBase: string;
		// Items in one import request; the server refuses more.
		batchSize: number;
		// The workspace's domains. A file link on one of them keeps its slug.
		domains: ImportDomain[];
		// The hostname of the default domain when domains does not name one.
		shortHost?: string;
		// Called after a run that created links, so the page reloads the list.
		onimported?: (created: number) => void;
	}

	let {
		open = $bindable(),
		onclose,
		apiBase,
		batchSize,
		domains,
		shortHost,
		onimported
	}: Props = $props();

	const workspace = shownWorkspace();
	const numbers = new Intl.NumberFormat();
	const lists = new Intl.ListFormat('en', { type: 'conjunction' });
	const previewLimit = 50;

	// The source only changes the export steps shown; the file itself decides how it is read.
	const sources = [
		{
			id: 'bitly',
			name: 'Bitly',
			file: 'CSV export',
			letter: 'b',
			help: 'Export your links from Bitly as a CSV file, then choose that file here.'
		},
		{
			id: 'dub',
			name: 'Dub',
			file: 'CSV export',
			letter: 'D',
			help: 'Export your links from Dub as a CSV file, then choose that file here.'
		},
		{
			id: 'rebrandly',
			name: 'Rebrandly',
			file: 'CSV export',
			letter: 'R',
			help: 'Export your links from Rebrandly as a CSV file, then choose that file here.'
		},
		{
			id: 'flared',
			name: 'Flared',
			file: 'JSON export',
			letter: 'F',
			help: 'Choose the JSON file from Workspace settings, Export, in another Flared workspace.'
		}
	] as const;
	let source = $state<(typeof sources)[number]['id']>('bitly');

	type Phase = 'choose' | 'reading' | 'checking' | 'preview' | 'importing' | 'done';
	// taken: a copied link whose ending is in use; it gets a new ending.
	type Check = { status: 'ready' | 'taken' } | { status: 'failed'; reason: string };
	type Final = { status: 'created' } | { status: 'failed'; reason: string };

	let phase = $state<Phase>('choose');
	let fileError = $state('');
	let stopError = $state('');
	let pauseNote = $state('');
	let file = $state.raw<ImportFile | null>(null);
	let parts = $state.raw<Extract<ShortColumns, { kind: 'parts' }> | null>(null);
	let shortChoice = $state('none');
	let destinationChoice = $state('');
	let titleChoice = $state('');
	let plan = $state.raw<ImportPlan | null>(null);
	let copyOthers = $state(false);
	let progress = $state({ done: 0, total: 0 });
	let created = $state(0);
	let failedHref = $state<string | null>(null);
	let fileInput = $state<HTMLInputElement>();
	// Results by plan row. The arrays can hold thousands of rows, so they are plain and version
	// tells the page when they change.
	const checks: (Check | undefined)[] = [];
	const finals: (Final | undefined)[] = [];
	let version = $state(0);
	let controller: AbortController | null = null;
	let reading = 0;

	const defaultHostname = $derived(
		domains.find((domain) => domain.isDefault)?.hostname ?? shortHost ?? null
	);
	const otherHosts = $derived.by(() => {
		const hosts = plan?.otherHosts ?? [];
		return hosts.length <= 3
			? lists.format(hosts)
			: `${hosts.slice(0, 3).join(', ')}, and ${hosts.length - 3} more`;
	});

	interface Counts {
		ready: number;
		other: number;
		otherReady: number;
		failed: { row: ImportRow; reason: string }[];
		send: number;
	}

	const counts = $derived.by((): Counts => {
		void version;
		const result: Counts = { ready: 0, other: 0, otherReady: 0, failed: [], send: 0 };
		plan?.rows.forEach((planned, index) => {
			if (planned.kind === 'invalid') {
				result.failed.push({ row: planned.row, reason: planned.reason });
				return;
			}
			const check = checks[index];
			if (planned.kind === 'other') result.other += 1;
			if (check?.status === 'failed') {
				if (planned.kind === 'own' || copyOthers)
					result.failed.push({ row: planned.row, reason: check.reason });
			} else if (check && planned.kind === 'own') result.ready += 1;
			else if (check) result.otherReady += 1;
		});
		result.failed.sort((a, b) => a.row.row - b.row.row);
		result.send = result.ready + (copyOthers ? result.otherReady : 0);
		return result;
	});

	const outcome = $derived.by(() => {
		void version;
		const failed: { row: ImportRow; reason: string }[] = [];
		let skipped = 0;
		plan?.rows.forEach((planned, index) => {
			const final = finals[index];
			const check = checks[index];
			if (planned.kind === 'invalid') failed.push({ row: planned.row, reason: planned.reason });
			else if (final?.status === 'failed') failed.push({ row: planned.row, reason: final.reason });
			else if (planned.kind === 'other' && !copyOthers) skipped += 1;
			else if (check?.status === 'failed') failed.push({ row: planned.row, reason: check.reason });
		});
		failed.sort((a, b) => a.row.row - b.row.row);
		return { failed, skipped };
	});

	const pending = $derived(phase === 'reading' || phase === 'checking' || phase === 'importing');

	function columnOptions(): { value: string; label: string }[] {
		return file?.kind === 'csv'
			? file.headers.map((header, index) => ({
					value: String(index),
					label: header || `Column ${index + 1}`
				}))
			: [];
	}

	function chosenColumns(): CsvColumns {
		let short: ShortColumns = { kind: 'none' };
		if (shortChoice === 'parts' && parts) short = parts;
		else if (shortChoice !== 'none' && shortChoice !== 'parts')
			short = { kind: 'url', column: Number(shortChoice) };
		return {
			short,
			destination: destinationChoice === '' ? null : Number(destinationChoice),
			title: titleChoice === '' ? null : Number(titleChoice)
		};
	}

	function choice(column: number | null): string {
		return column === null ? '' : String(column);
	}

	function stopRun() {
		controller?.abort();
		controller = null;
	}

	function clearResults() {
		checks.length = 0;
		finals.length = 0;
		version += 1;
	}

	// Clears everything the dialog learned from a file, but not the file input itself.
	function resetRun() {
		stopRun();
		reading += 1;
		if (failedHref) URL.revokeObjectURL(failedHref);
		failedHref = null;
		phase = 'choose';
		fileError = '';
		stopError = '';
		pauseNote = '';
		file = null;
		parts = null;
		plan = null;
		copyOthers = false;
		created = 0;
		progress = { done: 0, total: 0 };
		clearResults();
	}

	function reset() {
		resetRun();
		if (fileInput) fileInput.value = '';
	}

	function close() {
		reset();
		onclose?.();
	}

	async function choose(event: Event & { currentTarget: HTMLInputElement }) {
		const chosen = event.currentTarget.files?.[0];
		resetRun();
		const token = (reading += 1);
		if (!chosen) return;
		phase = 'reading';
		try {
			const kind = fileKind(chosen.name, '');
			const tooLarge = fileSizeProblem(kind, chosen.size);
			if (tooLarge) throw new ImportFileError(tooLarge);
			const source = await chosen.text();
			// Another file was chosen, or the dialog closed, while this one was read.
			if (token !== reading) return;
			const read = readImportFile(chosen.name, source);
			file = read;
			if (read.kind === 'csv') {
				const guess = guessColumns(read.headers);
				parts = guess.short.kind === 'parts' ? guess.short : null;
				shortChoice =
					guess.short.kind === 'url'
						? String(guess.short.column)
						: guess.short.kind === 'parts'
							? 'parts'
							: 'none';
				destinationChoice = choice(guess.destination);
				titleChoice = choice(guess.title);
			}
			await check();
		} catch (error) {
			if (token !== reading) return;
			phase = 'choose';
			fileError = error instanceof ImportFileError ? error.message : 'We could not read this file.';
		}
	}

	function rows(): ImportRow[] | null {
		if (!file) return null;
		if (file.kind === 'flared') return file.rows;
		const columns = chosenColumns();
		return columns.destination === null ? null : rowsFromCsv(file, columns);
	}

	function onRunEnd(
		end: ChunkRunEnd,
		sent: number[],
		mark: (index: number, reason: string) => void
	) {
		if (end.ok) return;
		stopError = importStopReason(end);
		for (const index of sent.slice(end.at)) mark(index, stopError);
	}

	// A dry run of every row that can be sent, as copies for rows on another service's domain.
	async function check() {
		stopRun();
		clearResults();
		stopError = '';
		pauseNote = '';
		const current = rows();
		plan = current ? planImport(current, domains, defaultHostname) : null;
		if (!plan) {
			phase = 'preview';
			return;
		}
		const sent: number[] = [];
		const items: ImportItemInput[] = [];
		plan.rows.forEach((planned, index) => {
			if (planned.kind === 'invalid') return;
			sent.push(index);
			items.push(planned.item);
		});
		const run = new AbortController();
		controller = run;
		phase = 'checking';
		progress = { done: 0, total: items.length };
		try {
			const end = await runImportChunks(items, {
				apiBase,
				headers: workspace(),
				batchSize,
				dryRun: true,
				signal: run.signal,
				onPause: (seconds) => (pauseNote = pausedText(seconds)),
				onChunk: (start, result) => {
					pauseNote = '';
					record(result, start, sent, (index, item) => {
						const planned = plan?.rows[index];
						if (item.status !== 'failed' || !item.error) checks[index] = { status: 'ready' };
						else if (planned?.kind === 'other' && item.error.code === 'SLUG_TAKEN')
							checks[index] = { status: 'taken' };
						else checks[index] = { status: 'failed', reason: importItemReason(item.error) };
					});
				}
			});
			onRunEnd(end, sent, () => {});
		} catch {
			if (run.signal.aborted) return;
			stopError = importStopReason({ code: 'NETWORK_ERROR', message: null, retryAfterSeconds: 0 });
		}
		controller = null;
		pauseNote = '';
		phase = 'preview';
	}

	function record(
		result: ImportLinksResult,
		start: number,
		sent: number[],
		write: (index: number, item: ImportLinksResult['results'][number]) => void
	) {
		for (const item of result.results) write(sent[start + item.index], item);
		progress = { done: start + result.results.length, total: progress.total };
		version += 1;
	}

	function pausedText(seconds: number): string {
		return `Too many requests at once. Continuing in ${seconds === 1 ? '1 second' : `${seconds} seconds`}.`;
	}

	async function runImport() {
		if (!plan || pending) return;
		const sent: number[] = [];
		const items: ImportItemInput[] = [];
		plan.rows.forEach((planned, index) => {
			const status = checks[index]?.status;
			if (planned.kind === 'invalid' || status === undefined || status === 'failed') return;
			if (planned.kind === 'other' && !copyOthers) return;
			sent.push(index);
			// A copy whose ending is taken goes without one, and Flared picks a new ending.
			items.push(status === 'taken' ? { ...planned.item, slug: undefined } : planned.item);
		});
		if (items.length === 0) return;
		const run = new AbortController();
		controller = run;
		phase = 'importing';
		stopError = '';
		progress = { done: 0, total: items.length };
		let made = 0;
		try {
			const end = await runImportChunks(items, {
				apiBase,
				headers: workspace(),
				batchSize,
				dryRun: false,
				signal: run.signal,
				onPause: (seconds) => (pauseNote = pausedText(seconds)),
				onChunk: (start, result) => {
					pauseNote = '';
					record(result, start, sent, (index, item) => {
						if (item.status === 'created') {
							finals[index] = { status: 'created' };
							made += 1;
						} else
							finals[index] = {
								status: 'failed',
								reason: item.error
									? importItemReason(item.error)
									: 'This link could not be imported.'
							};
					});
					created = made;
				}
			});
			onRunEnd(end, sent, (index, reason) => (finals[index] = { status: 'failed', reason }));
		} catch {
			if (run.signal.aborted) {
				if (made > 0) onimported?.(made);
				return;
			}
			stopError = importStopReason({ code: 'NETWORK_ERROR', message: null, retryAfterSeconds: 0 });
			for (const index of sent) finals[index] ??= { status: 'failed', reason: stopError };
		}
		controller = null;
		pauseNote = '';
		version += 1;
		phase = 'done';
		if (outcome.failed.length > 0)
			failedHref = URL.createObjectURL(
				new Blob([failedRowsCsv(outcome.failed)], { type: 'text/csv' })
			);
		if (made > 0) onimported?.(made);
	}

	function changeColumn(set: () => void) {
		set();
		void check();
	}
</script>

<Dialog bind:open title="Import links" id="import-links" onclose={close}>
	<div class="import">
		{#if phase === 'done'}
			<Callout tone={outcome.failed.length > 0 ? 'warning' : 'positive'} role="status">
				<p>
					Imported {numbers.format(created)}
					{created === 1 ? 'link' : 'links'}. {numbers.format(outcome.failed.length)} failed.
				</p>
				{#if outcome.skipped > 0}
					<p>
						Skipped {numbers.format(outcome.skipped)} on another service's domain.
					</p>
				{/if}
			</Callout>
			{#if stopError}<p class="error" role="alert">{stopError}</p>{/if}
			<div class="actions">
				{#if failedHref}
					<Button href={failedHref} download="flared-import-failed.csv" icon="download"
						>Download failed rows</Button
					>
				{/if}
				<Button variant="primary" onclick={() => (open = false)}>Done</Button>
			</div>
		{:else}
			{#if !file}
				<p class="help">
					Choose the file you exported. You check every row before Flared creates a link.
				</p>
				<fieldset class="sources">
					<legend class="visually-hidden">File source</legend>
					{#each sources as item (item.id)}
						<label class="source">
							<input
								type="radio"
								name="import-source"
								value={item.id}
								bind:group={source}
								class="visually-hidden"
							/>
							<span class="tile" aria-hidden="true">{item.letter}</span>
							<span class="source-text"
								><span class="name">{item.name}</span><span class="kind">{item.file}</span></span
							>
						</label>
					{/each}
				</fieldset>
				<p class="source-help">
					{sources.find((item) => item.id === source)?.help} A CSV from Short.io or another service works
					too.
				</p>
			{/if}
			<FormField for="import-file" label="File" error={fileError || null}>
				<input
					bind:this={fileInput}
					id="import-file"
					class="file"
					type="file"
					accept=".csv,.json,text/csv,application/json"
					disabled={phase === 'importing'}
					aria-invalid={fileError ? 'true' : undefined}
					aria-describedby={fileError ? 'import-file-error' : undefined}
					onchange={choose}
				/>
			</FormField>

			{#if phase === 'reading'}
				<p class="status" role="status">Reading the file…</p>
			{/if}

			{#if file?.kind === 'csv'}
				<div class="columns">
					<FormField for="import-short" label="Short link column">
						<Select
							id="import-short"
							value={shortChoice}
							disabled={phase === 'importing'}
							onchange={(event) => changeColumn(() => (shortChoice = event.currentTarget.value))}
						>
							<option value="none">None: give each link a new ending</option>
							{#if parts}<option value="parts">Hostname and slug columns</option>{/if}
							{#each columnOptions() as option (option.value)}
								<option value={option.value}>{option.label}</option>
							{/each}
						</Select>
					</FormField>
					<FormField for="import-destination" label="Destination column">
						<Select
							id="import-destination"
							value={destinationChoice}
							disabled={phase === 'importing'}
							onchange={(event) =>
								changeColumn(() => (destinationChoice = event.currentTarget.value))}
						>
							<option value="" disabled>Choose a column</option>
							{#each columnOptions() as option (option.value)}
								<option value={option.value}>{option.label}</option>
							{/each}
						</Select>
					</FormField>
					<FormField for="import-title" label="Title column (optional)">
						<Select
							id="import-title"
							value={titleChoice}
							disabled={phase === 'importing'}
							onchange={(event) => changeColumn(() => (titleChoice = event.currentTarget.value))}
						>
							<option value="">None</option>
							{#each columnOptions() as option (option.value)}
								<option value={option.value}>{option.label}</option>
							{/each}
						</Select>
					</FormField>
				</div>
				{#if destinationChoice === ''}
					<p class="error" role="alert">Choose the column with the destination URLs.</p>
				{/if}
			{/if}

			{#if plan}
				<ul class="counts">
					<li><strong>{numbers.format(counts.ready)}</strong> ready</li>
					<li><strong>{numbers.format(counts.other)}</strong> on another service's domain</li>
					<li><strong>{numbers.format(counts.failed.length)}</strong> cannot be imported</li>
				</ul>

				{#if counts.other > 0}
					<Checkbox
						bind:checked={copyOthers}
						disabled={phase === 'importing'}
						hint="The old short links keep working at the other service. A link whose ending is taken gets a new one."
						>Copy links on {otherHosts} to {defaultHostname ?? 'your default domain'}</Checkbox
					>
				{/if}

				{#if counts.failed.length > 0}
					<div class="failed">
						<p class="failed-title">Rows that cannot be imported</p>
						<ul>
							{#each counts.failed.slice(0, previewLimit) as failure (failure.row.row)}
								<li>
									<span class="row">Row {failure.row.row}</span>
									<span class="reason">{failure.reason}</span>
								</li>
							{/each}
						</ul>
						{#if counts.failed.length > previewLimit}
							<p class="more">
								And {numbers.format(counts.failed.length - previewLimit)} more. You can download them
								after the import.
							</p>
						{/if}
					</div>
				{/if}
			{/if}

			<p class="status" role="status" aria-live="polite">
				{#if pauseNote}{pauseNote}{:else if phase === 'checking'}Checking links… {numbers.format(
						progress.done
					)} of {numbers.format(progress.total)}{:else if phase === 'importing'}Importing links… {numbers.format(
						progress.done
					)} of {numbers.format(progress.total)}{/if}
			</p>
			{#if stopError}
				<p class="error" role="alert">{stopError}</p>
				{#if phase === 'preview'}
					<Button size="sm" onclick={() => void check()}>Check again</Button>
				{/if}
			{/if}

			<div class="actions">
				<Button onclick={() => (open = false)}>Cancel</Button>
				<Button
					variant="primary"
					disabled={pending || phase !== 'preview' || counts.send === 0}
					onclick={() => void runImport()}
					>Import {numbers.format(counts.send)} {counts.send === 1 ? 'link' : 'links'}</Button
				>
			</div>
			<p class="note">
				Links on your own domain keep their slugs. Connect the domain in Domains first.
			</p>
		{/if}
	</div>
</Dialog>

<style>
	.import {
		display: grid;
		gap: 1rem;
	}
	.help,
	.note,
	.more {
		color: var(--color-lead);
		font-size: 0.875rem;
	}
	.sources {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.5rem;
		min-width: 0;
		margin: 0;
		padding: 0;
		border: 0;
	}
	.source {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		min-width: 0;
		min-height: 3.75rem;
		padding: 0.625rem;
		border-radius: 0.75rem;
		background: var(--color-surface-2);
		font-size: 0.875rem;
		cursor: pointer;
	}
	.source:has(input:checked) {
		background: var(--color-surface);
		box-shadow: 0 0 0 2px var(--color-strong);
	}
	.source:has(input:focus-visible) {
		outline: 2px solid var(--color-focus);
		outline-offset: 2px;
	}
	.tile {
		display: grid;
		flex: none;
		place-items: center;
		width: 2rem;
		height: 2rem;
		border-radius: 0.5rem;
		background: var(--color-surface-3);
		color: var(--color-strong);
		font-size: 0.75rem;
		font-weight: 700;
		letter-spacing: -0.03em;
	}
	.source-text {
		display: grid;
		min-width: 0;
	}
	.name {
		color: var(--color-strong);
		font-weight: 600;
	}
	.kind {
		color: var(--color-subtle);
		font-size: 0.75rem;
	}
	.source-help {
		padding: 0.75rem 0.875rem;
		border-radius: 0.75rem;
		background: var(--color-surface-2);
		color: var(--color-muted);
		font-size: 0.875rem;
		line-height: 1.5;
	}
	.file {
		min-width: 0;
		color: var(--color-muted);
		font: inherit;
		font-size: 0.875rem;
	}
	/* The browser's own file button, as the primary button of the dialog. */
	.file::file-selector-button {
		min-height: 2.75rem;
		margin-right: 0.75rem;
		padding: 0 1rem;
		border: 0;
		border-radius: 0.5625rem;
		background: var(--color-button-primary);
		color: var(--color-on-primary);
		font: inherit;
		font-weight: 500;
		cursor: pointer;
	}
	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
	.columns {
		display: grid;
		gap: 0.75rem;
	}
	.columns :global(.select) {
		width: 100%;
	}
	.counts {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem 1.25rem;
		padding: 0;
		list-style: none;
		color: var(--color-ink);
		font-size: 0.9375rem;
		font-variant-numeric: tabular-nums;
	}
	.counts strong {
		color: var(--color-strong);
	}
	.failed {
		display: grid;
		gap: 0.4rem;
	}
	.failed-title {
		color: var(--color-strong);
		font-size: 0.9375rem;
		font-weight: 600;
	}
	.failed ul {
		display: grid;
		max-height: 12rem;
		margin: 0;
		padding: 0;
		overflow-y: auto;
		border: 1px solid var(--color-rule);
		border-radius: var(--radius-md, 0.625rem);
		list-style: none;
	}
	.failed li {
		display: grid;
		gap: 0.1rem;
		padding: 0.5rem 0.75rem;
		font-size: 0.875rem;
	}
	.failed li + li {
		border-top: 1px solid var(--color-rule);
	}
	.row {
		color: var(--color-strong);
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}
	.reason {
		color: var(--color-ink);
	}
	.status {
		color: var(--color-lead);
		font-size: 0.875rem;
		font-variant-numeric: tabular-nums;
	}
	.status:empty {
		display: none;
	}
	.error {
		color: var(--color-danger);
		font-size: 0.875rem;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 0.75rem;
	}
</style>
