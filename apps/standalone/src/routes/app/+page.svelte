<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import type { Action } from 'svelte/action';
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import Button from '@flared/ui/atoms/Button.svelte';
	import ApplyAutomationDialog from '@flared/ui/automations/ApplyAutomationDialog.svelte';
	import ImportDialog from '@flared/ui/links/ImportDialog.svelte';
	import LinkCreateForm from '@flared/ui/links/LinkCreateForm.svelte';
	import LinkList from '@flared/ui/links/LinkList.svelte';
	import { linkErrorMessage } from '@flared/ui/links/messages';
	import { appRoutes, linkRoute } from '$lib/routes';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
	let pending = $state(false);
	let importing = $state(false);
	let selectedIds = $state<string[]>([]);
	let applying = $state(false);
	// The templates of the bulk action: none when they failed to load or automations are off.
	const automations = $derived(
		data.automations && data.automations.limit > 0 ? data.automations.automations : []
	);

	const createError = $derived(
		form && 'error' in form && form.error
			? { message: linkErrorMessage(form.error.code, form.error.message), field: form.error.field }
			: null
	);
	const idempotencyKey = $derived(
		form && 'idempotencyKey' in form && form.idempotencyKey
			? form.idempotencyKey
			: data.idempotencyKey
	);
	const createdId = $derived(form && 'created' in form && form.created ? form.created.id : null);
	const defaultHost = $derived(
		data.domains.find((domain) => domain.isDefault)?.hostname ?? page.url.host
	);
	const numbers = new Intl.NumberFormat();

	// The failure list of the bulk action names each link as the list does.
	function linkName(id: string): string {
		const link =
			data.links.status === 'ready' ? data.links.links.find((item) => item.id === id) : undefined;
		return link ? (link.title ?? `${link.hostname}/${link.slug}`) : id;
	}

	const enhanceCreate: Action<HTMLFormElement> = (node) =>
		enhance(node, () => {
			pending = true;
			return async ({ update }) => {
				await update();
				pending = false;
			};
		});
</script>

<svelte:head><title>Links · Flared</title></svelte:head>

<div class="page-head head-row">
	<h1>Links</h1>
	<div class="head-actions">
		{#if data.usage}
			<p class="usage">
				{numbers.format(data.usage.clicks)} of {numbers.format(data.usage.clickLimit)} clicks this month
			</p>
		{/if}
		{#if data.links.status === 'ready'}
			<Button size="sm" icon="download" onclick={() => (importing = true)}>Import</Button>
		{/if}
	</div>
</div>
{#if data.links.status !== 'ready'}
	<section class="notice" role="alert">
		<h2>We couldn’t load your links</h2>
		<p>Refresh the page to try again.</p>
	</section>
{:else}
	<LinkCreateForm
		action="?/create"
		{idempotencyKey}
		shortHost={defaultHost}
		values={form && 'values' in form && form.values ? form.values : undefined}
		error={createError}
		{pending}
		enhance={enhanceCreate}
		domains={data.domains}
	/>
	<LinkList
		links={data.links.links}
		analyticsHref={(link) => linkRoute(link.id)}
		editHref={(link) => `${linkRoute(link.id)}#edit`}
		nextHref={data.links.nextCursor ? `?cursor=${encodeURIComponent(data.links.nextCursor)}` : null}
		highlightId={createdId}
		iconHref={(hostname) => `/api/v1/icons/${hostname}`}
		selectable={automations.length > 0}
		bind:selectedIds
	>
		{#snippet bulkBar()}
			<Button size="sm" icon="lightning" onclick={() => (applying = true)}>Apply automation</Button>
		{/snippet}
	</LinkList>
	{#if automations.length > 0}
		<ApplyAutomationDialog
			bind:open={applying}
			linkIds={selectedIds}
			{automations}
			apiBase="/api/v1"
			{linkName}
			automationsHref={appRoutes.automations}
			onapplied={() => void invalidateAll()}
		/>
	{/if}
	<ImportDialog
		bind:open={importing}
		apiBase="/api/v1"
		batchSize={3}
		domains={data.domains}
		shortHost={defaultHost}
		onimported={() => void invalidateAll()}
	/>
{/if}

<style>
	.head-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
	}
	.head-actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: flex-end;
		gap: 0.75rem;
	}
	.usage {
		font-size: 0.85rem;
		font-variant-numeric: tabular-nums;
	}
</style>
