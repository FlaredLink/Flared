<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import {
		extraBlockKinds,
		maxPageBioLength,
		maxPageBlocks,
		maxPageTitleLength,
		type Page,
		type PageBlockKind
	} from '@flared/contracts/pages';
	import Button from '../atoms/Button.svelte';
	import Select from '../atoms/Select.svelte';
	import TextInput from '../atoms/TextInput.svelte';
	import Callout from '../molecules/Callout.svelte';
	import Menu, { type MenuItem } from '../molecules/Menu.svelte';
	import { shownWorkspace } from '../workspace/shown';
	import BlockEditor, { blockKinds } from './BlockEditor.svelte';
	import PageImageField from './PageImageField.svelte';
	import PagePreview from './PagePreview.svelte';
	import ThemeFields from './ThemeFields.svelte';
	import { createButtonLink, pageErrorMessage, updatePage } from './client';
	import {
		changeOf,
		draftOf,
		isDirty,
		isLinked,
		missingLinks,
		newBlock,
		previewOf,
		type PageDraft
	} from './draft';
	import { pageTemplate } from './templates';

	interface Props {
		apiBase: string;
		page: Page;
		// Workspace domains that can show a page at their root.
		domains: { id: string; hostname: string }[];
		// Why the workspace cannot use payment cards, embeds, or a domain, such as its plan.
		extrasUnavailable?: string | null;
		// Whether the page shows "Made with Flared".
		badge?: boolean;
		// A template from the new page dialog: its sample blocks fill an empty page until Save.
		template?: string | null;
		// True while the draft has changes, so the app can ask before it leaves the page.
		dirty?: boolean;
		onsaved: (page: Page) => void;
	}

	let {
		apiBase,
		page,
		domains,
		extrasUnavailable = null,
		badge = false,
		template = null,
		dirty = $bindable(false),
		onsaved
	}: Props = $props();
	const workspace = shownWorkspace();

	function initialDraft(from: Page): PageDraft {
		const draft = draftOf(from);
		const starter = pageTemplate(template);
		if (starter && draft.blocks.length === 0)
			draft.blocks = starter.blocks.map((block) => newBlock(block.kind, block.label));
		return draft;
	}

	let saved = $state(untrack(() => page));
	let draft = $state(untrack(() => initialDraft(page)));
	let pending = $state(false);
	let errors = $state<Record<string, string>>({});
	let formError = $state('');
	let status = $state('');
	// Schedules and the preview follow the clock; the server renders with its own time.
	let now = $state(Date.now());
	onMount(() => {
		const timer = setInterval(() => (now = Date.now()), 60000);
		return () => clearInterval(timer);
	});

	$effect(() => {
		dirty = isDirty(draft, saved);
	});

	const host = $derived(
		saved.url ? new URL(saved.url).hostname.slice(saved.handle.length + 1) : null
	);
	const address = $derived(saved.domainUrl ?? saved.url);
	const preview = $derived(
		previewOf(
			draft,
			{ avatarUrl: saved.avatarImage, backgroundUrl: saved.backgroundImage },
			{ url: address ?? 'https://example.com', badge, now }
		)
	);
	const blocked = $derived(saved.blocked !== null);

	const addItems = $derived<MenuItem[]>(
		(['button', 'header', 'social', 'payment', 'embed'] as const).map((kind: PageBlockKind) => ({
			label: blockKinds[kind].name,
			icon: blockKinds[kind].icon,
			disabled:
				draft.blocks.length >= maxPageBlocks ||
				(extrasUnavailable !== null && extraBlockKinds.includes(kind)),
			onselect: () => {
				draft.blocks.push(newBlock(kind));
			}
		}))
	);

	function move(index: number, delta: -1 | 1) {
		const target = index + delta;
		if (target < 0 || target >= draft.blocks.length) return;
		const [block] = draft.blocks.splice(index, 1);
		draft.blocks.splice(target, 0, block);
		status = `Moved to position ${target + 1} of ${draft.blocks.length}.`;
	}

	function remove(index: number) {
		const [block] = draft.blocks.splice(index, 1);
		status = `${blockKinds[block.kind].name} removed. Save to update the page.`;
	}

	// Drag a block by its card to a new place; the buttons do the same from the keyboard.
	let dragging = $state<string | null>(null);
	function drop(index: number) {
		const from = draft.blocks.findIndex((block) => block.key === dragging);
		dragging = null;
		if (from < 0 || from === index) return;
		const [block] = draft.blocks.splice(from, 1);
		draft.blocks.splice(index, 0, block);
	}

	const fieldError = (field: string) => errors[field] ?? null;
	const blockError = (index: number) => (field: string) =>
		errors[`blocks.${index}.${field}`] ?? null;

	async function save() {
		if (pending || blocked) return;
		errors = {};
		formError = '';
		status = '';
		const missing = missingLinks(draft);
		if (missing.length > 0) {
			errors = Object.fromEntries(missing.map((problem) => [problem.field, problem.message]));
			formError = 'Some buttons need a link. Paste a destination or choose a link.';
			return;
		}
		pending = true;
		// New destinations become links first. A link made here stays in the block, so a failed
		// save does not make it again.
		for (const [index, block] of draft.blocks.entries()) {
			if (!isLinked(block) || block.linkId !== null) continue;
			const result = await createButtonLink(
				apiBase,
				{
					destination: block.destination,
					title: block.label,
					idempotencyKey: block.idempotencyKey
				},
				workspace()
			);
			if (!result.ok) {
				pending = false;
				const message = pageErrorMessage(result.failure);
				errors = { [`blocks.${index}.destination`]: message };
				formError = message;
				return;
			}
			block.linkId = result.value.id;
			block.shortUrl = result.value.shortUrl;
			block.destination = '';
		}
		const change = changeOf(draft, saved);
		if (Object.keys(change).length === 0) {
			pending = false;
			status = 'No changes to save.';
			return;
		}
		const result = await updatePage(apiBase, saved.id, change, workspace());
		pending = false;
		if (!result.ok) {
			const message = pageErrorMessage(result.failure);
			if (result.failure.field) errors = { [result.failure.field]: message };
			formError = message;
			return;
		}
		saved = result.value;
		draft = draftOf(result.value);
		status = 'Saved.';
		onsaved(result.value);
	}

	function imageChanged(next: Page) {
		saved = { ...next };
		onsaved(next);
	}
</script>

<div class="editor">
	<div class="form">
		{#if blocked}
			<Callout tone="danger" title="This page is blocked">
				<p>Flared blocked this page for abuse. It does not show, and you cannot change it.</p>
			</Callout>
		{/if}

		<section class="section" aria-labelledby="page-profile-heading">
			<h2 id="page-profile-heading">Profile</h2>
			<div class="field">
				<label for="page-title">Name</label>
				<TextInput
					id="page-title"
					bind:value={draft.title}
					maxlength={maxPageTitleLength}
					autocomplete="off"
					invalid={fieldError('title') !== null}
				/>
				{#if fieldError('title')}<p class="error" role="alert">{fieldError('title')}</p>{/if}
			</div>
			<div class="field">
				<label for="page-bio">Bio <span class="optional">optional</span></label>
				<textarea
					id="page-bio"
					class="textarea"
					class:invalid={fieldError('bio') !== null}
					bind:value={draft.bio}
					maxlength={maxPageBioLength}
					rows="3"></textarea>
				<p class="hint">{draft.bio.length} of {maxPageBioLength} characters.</p>
				{#if fieldError('bio')}<p class="error" role="alert">{fieldError('bio')}</p>{/if}
			</div>
			<PageImageField
				{apiBase}
				page={saved}
				slot="avatar"
				label="Profile picture"
				hint="PNG, JPEG, or WebP, up to 5 MB. It saves at once."
				disabled={blocked}
				onchange={imageChanged}
			/>
		</section>

		<section class="section" aria-labelledby="page-blocks-heading">
			<div class="section-head">
				<h2 id="page-blocks-heading">Blocks</h2>
				<Menu id="page-add-block" label="Add a block" icon="plus" text="Add" items={addItems} />
			</div>
			{#if extrasUnavailable !== null}
				<p class="hint">{extrasUnavailable}</p>
			{/if}
			{#if draft.blocks.length === 0}
				<p class="empty">Add a button for each link you want to share.</p>
			{:else}
				<ol class="blocks">
					{#each draft.blocks as block, index (block.key)}
						<li
							class:dragging={dragging === block.key}
							draggable={dragging === block.key ? 'true' : 'false'}
							ondragstart={(event) => event.dataTransfer?.setData('text/plain', block.key)}
							ondragend={() => (dragging = null)}
							onpointerup={() => (dragging = null)}
							ondragover={(event) => {
								if (dragging) event.preventDefault();
							}}
							ondrop={(event) => {
								event.preventDefault();
								drop(index);
							}}
							onpointerdown={(event) => {
								// Only the grip starts a drag, so text in the fields stays selectable.
								if (event.target instanceof Element && event.target.closest('.handle'))
									dragging = block.key;
							}}
						>
							<BlockEditor
								{apiBase}
								bind:block={draft.blocks[index]}
								{index}
								count={draft.blocks.length}
								{extrasUnavailable}
								errorFor={blockError(index)}
								{now}
								onmove={(delta) => move(index, delta)}
								onremove={() => remove(index)}
							/>
						</li>
					{/each}
				</ol>
			{/if}
		</section>

		<section class="section" aria-labelledby="page-look-heading">
			<h2 id="page-look-heading">Look</h2>
			<ThemeFields bind:theme={draft.theme} />
			<PageImageField
				{apiBase}
				page={saved}
				slot="background"
				label="Background image"
				hint="Shown behind the page. PNG, JPEG, or WebP, up to 5 MB. It saves at once."
				disabled={blocked}
				onchange={imageChanged}
			/>
		</section>

		<section class="section" aria-labelledby="page-address-heading">
			<h2 id="page-address-heading">Address</h2>
			<div class="field">
				<label for="page-handle">{host ? 'Page address' : 'Page name'}</label>
				<TextInput
					id="page-handle"
					bind:value={draft.handle}
					maxlength={30}
					autocomplete="off"
					autocapitalize="off"
					spellcheck="false"
					mono
					invalid={fieldError('handle') !== null}
					aria-describedby="page-handle-hint"
				>
					{#snippet end()}{#if host}<span class="suffix">.{host}</span>{/if}{/snippet}
				</TextInput>
				<p class="hint" id="page-handle-hint">
					Lowercase letters, digits, and hyphens. After a change, the old address sends visitors to
					the new one for 90 days.
				</p>
				{#if fieldError('handle')}<p class="error" role="alert">{fieldError('handle')}</p>{/if}
			</div>
			<div class="field">
				<label for="page-domain">Show at the root of a domain</label>
				<Select
					id="page-domain"
					value={draft.domainId ?? ''}
					disabled={extrasUnavailable !== null && draft.domainId === null}
					onchange={(event) => (draft.domainId = event.currentTarget.value || null)}
				>
					<option value="">{host ? 'No domain' : 'No domain: the page does not show'}</option>
					{#each domains as domain (domain.id)}
						<option value={domain.id}>{domain.hostname}</option>
					{/each}
				</Select>
				<p class="hint">
					{#if extrasUnavailable !== null}{extrasUnavailable}{:else if domains.length === 0}Add a
						domain on the Domains page first.{:else}The page shows at the domain's address. Short
						links on the domain keep working.{/if}
				</p>
				{#if fieldError('domainId')}<p class="error" role="alert">{fieldError('domainId')}</p>{/if}
			</div>
		</section>

		<div class="save-bar">
			<p class="save-status" role="status" aria-live="polite">
				{#if formError}<span class="error">{formError}</span
					>{:else if status}{status}{:else if dirty}Unsaved changes{/if}
			</p>
			<Button variant="primary" disabled={pending || blocked || !dirty} onclick={() => void save()}
				>{pending ? 'Saving…' : 'Save'}</Button
			>
		</div>
	</div>

	<aside class="side" aria-label="Preview">
		<PagePreview view={preview} />
		{#if !address}
			<p class="hint">Choose a domain under Address so the page can show.</p>
		{/if}
	</aside>
</div>

<style>
	.editor {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 1.5rem;
		align-items: start;
	}
	.form {
		display: grid;
		gap: 1.25rem;
		min-width: 0;
	}
	.section {
		display: grid;
		gap: 0.875rem;
		padding: 1rem;
		border-radius: 0.875rem;
		background: var(--color-surface);
		box-shadow: var(--shadow-ring);
	}
	.section h2 {
		color: var(--color-strong);
		font-size: 1.0625rem;
		font-weight: 650;
	}
	.section-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
	}
	.field {
		display: grid;
		gap: 0.25rem;
	}
	label {
		color: var(--color-strong);
		font-size: 0.875rem;
		font-weight: 500;
	}
	.optional {
		color: var(--color-subtle);
		font-weight: 400;
	}
	.hint,
	.empty {
		color: var(--color-lead);
		font-size: 0.8125rem;
	}
	.empty {
		font-size: 0.875rem;
	}
	.error {
		color: var(--color-danger);
		font-size: 0.875rem;
	}
	.textarea {
		min-height: 5.5rem;
		padding: 0.625rem 0.9rem;
		border: 0;
		border-radius: var(--radius-control, 0.5rem);
		background: var(--color-surface-2);
		box-shadow: var(--shadow-ring);
		color: var(--color-strong);
		font: inherit;
		/* 16px on phones, so iOS does not zoom into the field. */
		font-size: 1rem;
		resize: vertical;
		outline: none;
	}
	.textarea:focus-visible {
		box-shadow: 0 0 0 2px var(--color-focus);
	}
	.textarea.invalid {
		box-shadow: 0 0 0 1px var(--color-danger);
	}
	.suffix {
		color: var(--color-subtle);
		font-family: var(--font-mono);
		font-size: 0.875rem;
		white-space: nowrap;
	}
	.blocks {
		display: grid;
		gap: 0.5rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.blocks li.dragging {
		opacity: 0.5;
	}
	/* The save bar stays in view at the bottom of the form while the page scrolls, above any bar
	   that the app fixes to the bottom of the screen (--app-bottom-inset). */
	.save-bar {
		position: sticky;
		bottom: calc(var(--app-bottom-inset, 0px) + 0.5rem);
		z-index: 2;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.75rem 1rem;
		border-radius: 0.875rem;
		background: var(--color-surface);
		box-shadow: var(--shadow-lift);
	}
	.save-status {
		min-width: 0;
		color: var(--color-muted);
		font-size: 0.875rem;
	}
	.side {
		display: grid;
		gap: 0.5rem;
	}
	@media (min-width: 64rem) {
		.editor {
			grid-template-columns: minmax(0, 1fr) 22.5rem;
		}
		.side {
			position: sticky;
			top: 5rem;
		}
		.section {
			padding: 1.25rem;
		}
		.textarea {
			font-size: 0.9375rem;
		}
	}
</style>
