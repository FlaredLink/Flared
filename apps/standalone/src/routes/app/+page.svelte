<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import type { Action } from 'svelte/action';
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import LinkCreateForm from '@flared/ui/links/LinkCreateForm.svelte';
	import LinkList from '@flared/ui/links/LinkList.svelte';
	import { linkErrorMessage } from '@flared/ui/links/messages';
	import { linkRoute } from '$lib/routes';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
	let pending = $state(false);

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
	{#if data.usage}
		<p class="usage">
			{numbers.format(data.usage.clicks)} of {numbers.format(data.usage.clickLimit)} clicks this month
		</p>
	{/if}
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
		nextHref={data.links.nextCursor ? `?cursor=${encodeURIComponent(data.links.nextCursor)}` : null}
		highlightId={createdId}
		iconHref={(hostname) => `/api/v1/icons/${hostname}`}
	/>
{/if}

<style>
	.head-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
	}
	.usage {
		font-size: 0.85rem;
		font-variant-numeric: tabular-nums;
	}
</style>
