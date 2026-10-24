<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import { tick } from 'svelte';
	import {
		handlePattern,
		maxPageTitleLength,
		themePreset,
		type Page,
		type PageList
	} from '@flared/contracts/pages';
	import Glyph from '../icons/Glyph.svelte';
	import Button from '../atoms/Button.svelte';
	import StatusDot from '../atoms/StatusDot.svelte';
	import TextInput from '../atoms/TextInput.svelte';
	import Callout from '../molecules/Callout.svelte';
	import Dialog from '../molecules/Dialog.svelte';
	import PageHeader from '../molecules/PageHeader.svelte';
	import { blockLabel } from '../links/messages';
	import { shownWorkspace } from '../workspace/shown';
	import { createPage, pageErrorMessage } from './client';
	import { pageTemplate, pageTemplates } from './templates';

	interface Props {
		list: PageList;
		apiBase: string;
		// The host that serves <handle>.<host>, such as flared.site. Without it, a page shows only
		// at the root of a workspace domain.
		pageHost?: string | null;
		// The editor of one page, such as "/app/pages/abc".
		editHref: (page: { id: string }) => string;
		// Opens the editor of a new page.
		onCreated: (page: Page, template: string) => void | Promise<void>;
		// How many pages the workspace may have; null for no limit.
		limit?: number | null;
		// Shown when the workspace has no room for another page, such as the plan's limit.
		limitMessage?: string;
	}

	let {
		list,
		apiBase,
		pageHost = null,
		editHref,
		onCreated,
		limit = null,
		limitMessage = 'Your workspace has reached its page limit.'
	}: Props = $props();
	const workspace = shownWorkspace();

	const empty = $derived(list.pages.length === 0);
	const atLimit = $derived(limit !== null && list.pages.length >= limit);
	const numbers = new Intl.NumberFormat();

	let creating = $state(false);
	let template = $state('blank');
	let title = $state('');
	let handle = $state('');
	let handleEdited = $state(false);
	let pending = $state(false);
	let error = $state('');
	let errorField = $state<string | null>(null);
	let titleInput = $state<HTMLInputElement>();

	// The address follows the name until the person edits it.
	function suggested(name: string): string {
		return name
			.toLowerCase()
			.normalize('NFKD')
			.replace(/[̀-ͯ]/g, '')
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 30)
			.replace(/-+$/, '');
	}

	async function open() {
		creating = true;
		template = 'blank';
		title = '';
		handle = '';
		handleEdited = false;
		error = '';
		errorField = null;
		await tick();
		titleInput?.focus();
	}

	async function create(event: SubmitEvent) {
		event.preventDefault();
		if (pending) return;
		error = '';
		errorField = null;
		const address = handle.trim().toLowerCase();
		if (!title.trim()) {
			error = 'Enter a name for the page.';
			errorField = 'title';
			return;
		}
		if (!handlePattern.test(address)) {
			error =
				'Use 3 to 30 lowercase letters, digits, or single hyphens for the address. Start and end with a letter or digit.';
			errorField = 'handle';
			return;
		}
		pending = true;
		const result = await createPage(
			apiBase,
			{
				handle: address,
				title: title.trim(),
				theme: { id: pageTemplate(template)?.theme ?? 'paper' }
			},
			workspace()
		);
		if (!result.ok) {
			pending = false;
			error = pageErrorMessage(result.failure);
			errorField = result.failure.field;
			return;
		}
		await onCreated(result.value, template);
		pending = false;
		creating = false;
	}

	function shownAddress(page: PageList['pages'][number]): string | null {
		const address = page.domainUrl ?? page.url;
		return address ? address.replace(/^https:\/\//, '') : null;
	}
</script>

<PageHeader title="Pages" count={empty ? undefined : list.pages.length}>
	{#snippet top()}
		{#if limit !== null}
			<span class="usage" class:warn={atLimit}
				>{numbers.format(list.pages.length)} of {numbers.format(limit)}
				{limit === 1 ? 'page' : 'pages'} used</span
			>
		{/if}
	{/snippet}
	{#snippet aside()}
		{#if !empty}
			<Button size="sm" variant="primary" icon="plus" disabled={atLimit} onclick={() => void open()}
				>New<span class="wide-label">&nbsp;page</span></Button
			>
		{/if}
	{/snippet}
</PageHeader>

<div class="pages">
	{#if empty}
		<section class="first" aria-labelledby="page-first-heading">
			<span class="first-mark" aria-hidden="true"><Glyph name="browser" size={22} /></span>
			<h2 id="page-first-heading">Make a page for your links</h2>
			{#if atLimit}
				<p class="first-lead">{limitMessage}</p>
			{:else}
				<p class="first-lead">
					One page with your name, picture, and a button for each link. Each button is a short link,
					so its clicks show in your analytics.
				</p>
				<Button variant="primary" icon="plus" onclick={() => void open()}>New page</Button>
			{/if}
		</section>
	{:else}
		<ul class="cards" aria-label="Pages">
			{#each list.pages as page (page.id)}
				{@const address = shownAddress(page)}
				<li class="card">
					<a class="main" href={editHref(page)}>
						<span class="title">{page.title}</span>
						<span class="address">{address ?? 'Not shown: choose a domain'}</span>
					</a>
					<span class="state">
						{#if page.blocked}
							<StatusDot tone="danger">{blockLabel(page.blocked.reason)}</StatusDot>
						{:else if page.enabled}
							<StatusDot>On</StatusDot>
						{:else}
							<StatusDot tone="neutral">Off</StatusDot>
						{/if}
					</span>
					{#if address && page.enabled && !page.blocked}
						<a
							class="open"
							href={page.domainUrl ?? page.url}
							target="_blank"
							rel="noopener noreferrer"
							aria-label="Open {page.title}"><Glyph name="arrowUpRight" size={18} /></a
						>
					{/if}
				</li>
			{/each}
		</ul>
		{#if atLimit}<p class="note">{limitMessage}</p>{/if}
	{/if}
</div>

<Dialog bind:open={creating} id="page-new-heading" title="New page">
	<form class="new" onsubmit={create} novalidate>
		<fieldset>
			<legend>Start from</legend>
			<div class="templates">
				{#each pageTemplates as item (item.id)}
					{@const theme = themePreset(item.theme)}
					<label class="template" class:chosen={template === item.id}>
						<input
							type="radio"
							name="page-template"
							value={item.id}
							checked={template === item.id}
							onchange={() => (template = item.id)}
						/>
						<span
							class="swatch"
							aria-hidden="true"
							style:background={theme?.background}
							style:color={theme?.buttonBackground}
						>
							<span class="bar"></span><span class="bar"></span>
						</span>
						<span class="template-name">{item.name}</span>
						<span class="template-text">{item.description}</span>
					</label>
				{/each}
			</div>
		</fieldset>
		<div class="field">
			<label for="page-new-title">Name</label>
			<TextInput
				id="page-new-title"
				bind:input={titleInput}
				bind:value={title}
				maxlength={maxPageTitleLength}
				autocomplete="off"
				placeholder="Your name or brand"
				oninput={() => {
					if (!handleEdited) handle = suggested(title);
				}}
				invalid={errorField === 'title'}
			/>
		</div>
		<div class="field">
			<label for="page-new-handle">{pageHost ? 'Address' : 'Page name in the address'}</label>
			<TextInput
				id="page-new-handle"
				bind:value={handle}
				maxlength={30}
				autocomplete="off"
				autocapitalize="off"
				spellcheck="false"
				mono
				oninput={() => (handleEdited = true)}
				invalid={errorField === 'handle'}
				aria-describedby="page-new-handle-hint"
			>
				{#snippet end()}{#if pageHost}<span class="suffix">.{pageHost}</span>{/if}{/snippet}
			</TextInput>
			<p class="hint" id="page-new-handle-hint">
				{pageHost
					? 'You can change it later. A used address stays with your workspace.'
					: 'A page shows at the root of a domain; choose the domain in the editor.'}
			</p>
		</div>
		{#if error}<Callout tone="danger" role="alert"><p>{error}</p></Callout>{/if}
		<div class="buttons">
			<Button type="button" disabled={pending} onclick={() => (creating = false)}>Cancel</Button>
			<Button type="submit" variant="primary" disabled={pending}
				>{pending ? 'Creating…' : 'Create page'}</Button
			>
		</div>
	</form>
</Dialog>

<style>
	.pages {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 1.25rem;
		width: min(100%, 56rem);
	}
	.usage {
		color: var(--color-subtle);
		font-size: 0.8125rem;
	}
	.usage.warn {
		color: var(--color-warning);
	}
	/* The button reads "New" on a phone and keeps the full name for screen readers. */
	.wide-label {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
	.first {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		justify-items: start;
		gap: 0.75rem;
		padding: 1.25rem 1rem;
		border-radius: 0.875rem;
		background: var(--color-surface);
		box-shadow: var(--shadow-ring);
	}
	.first-mark {
		display: grid;
		place-items: center;
		width: 2.5rem;
		height: 2.5rem;
		border-radius: 0.625rem;
		background: var(--color-surface-2);
		color: var(--color-strong);
	}
	.first h2 {
		color: var(--color-strong);
		font-size: 1.25rem;
		font-weight: 600;
		letter-spacing: -0.01em;
	}
	.first-lead {
		color: var(--color-muted);
		font-size: 0.9375rem;
	}
	.cards {
		display: grid;
		gap: 0.625rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.card {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.75rem 1rem;
		border-radius: 0.875rem;
		background: var(--color-surface);
		box-shadow: var(--shadow-ring);
	}
	.main {
		display: grid;
		flex: 1;
		gap: 0.125rem;
		min-width: 0;
		min-height: 2.75rem;
		align-content: center;
	}
	.main:hover .title {
		text-decoration: underline;
		text-underline-offset: 3px;
	}
	.title {
		color: var(--color-strong);
		font-size: 0.9375rem;
		font-weight: 600;
		overflow-wrap: anywhere;
	}
	.address {
		overflow: hidden;
		color: var(--color-muted);
		font-family: var(--font-mono);
		font-size: 0.8125rem;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.state {
		flex: none;
	}
	.open {
		display: grid;
		flex: none;
		place-items: center;
		width: 2.75rem;
		height: 2.75rem;
		border-radius: var(--radius-control, 0.5rem);
		color: var(--color-muted);
	}
	.open:hover {
		background: var(--color-hover);
		color: var(--color-strong);
	}
	.note {
		color: var(--color-subtle);
		font-size: 0.875rem;
	}
	.new {
		display: grid;
		gap: 1rem;
	}
	fieldset {
		min-width: 0;
		margin: 0;
		padding: 0;
		border: 0;
	}
	legend,
	label {
		color: var(--color-strong);
		font-size: 0.875rem;
		font-weight: 500;
	}
	legend {
		margin-bottom: 0.5rem;
		padding: 0;
	}
	.templates {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.5rem;
	}
	.template {
		display: grid;
		gap: 0.25rem;
		padding: 0.5rem;
		border-radius: 0.75rem;
		box-shadow: inset 0 0 0 1px var(--color-rule);
		cursor: pointer;
	}
	.template input {
		position: absolute;
		opacity: 0;
		pointer-events: none;
	}
	.template.chosen {
		background: var(--color-surface);
		box-shadow: var(--shadow-ring);
	}
	.template:has(input:focus-visible) {
		box-shadow: 0 0 0 2px var(--color-focus);
	}
	.swatch {
		display: grid;
		gap: 0.25rem;
		padding: 0.5rem;
		border-radius: 0.5rem;
		box-shadow: inset 0 0 0 1px var(--color-rule);
	}
	.bar {
		display: block;
		height: 0.375rem;
		border-radius: 999px;
		background: currentColor;
	}
	.template-name {
		color: var(--color-strong);
		font-size: 0.875rem;
		font-weight: 600;
	}
	.template-text {
		color: var(--color-muted);
		font-size: 0.75rem;
		font-weight: 400;
	}
	.field {
		display: grid;
		gap: 0.25rem;
	}
	.hint {
		color: var(--color-lead);
		font-size: 0.8125rem;
	}
	.suffix {
		color: var(--color-subtle);
		font-family: var(--font-mono);
		font-size: 0.875rem;
		white-space: nowrap;
	}
	.buttons {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.5rem;
	}
	@media (min-width: 40rem) {
		.templates {
			grid-template-columns: repeat(4, minmax(0, 1fr));
		}
	}
	@media (min-width: 48rem) {
		.wide-label {
			position: static;
			width: auto;
			height: auto;
			overflow: visible;
			clip-path: none;
		}
		.first {
			padding: 1.5rem;
		}
		.buttons {
			display: flex;
			justify-content: flex-end;
		}
	}
</style>
