<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import LinkAnalytics from '@flared/ui/analytics/LinkAnalytics.svelte';
	import LinkQr from '@flared/ui/links/LinkQr.svelte';
	import type { Action } from 'svelte/action';
	import { enhance } from '$app/forms';
	import LinkEditForm from '@flared/ui/links/LinkEditForm.svelte';
	import { blockLabel, linkErrorMessage } from '@flared/ui/links/messages';
	import { appRoutes } from '$lib/routes';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
	let pending = $state(false);

	const shortName = $derived(data.link.shortUrl.replace(/^https?:\/\//, ''));
	const notices = {
		edit: 'Saved.',
		enable: 'Link enabled. The short link opens again.',
		disable: 'Link disabled. The short link no longer opens.'
	} as const;
	const editError = $derived(
		form && 'error' in form && form.error
			? { message: linkErrorMessage(form.error.code, form.error.message), field: form.error.field }
			: null
	);
	const editValues = $derived(form && 'values' in form ? form.values : null);
	const notice = $derived(form && 'updated' in form && form.updated ? notices[form.updated] : '');

	const enhanceEdit: Action<HTMLFormElement> = (node) =>
		enhance(node, () => {
			pending = true;
			return async ({ update }) => {
				await update({ reset: false });
				pending = false;
			};
		});

	const ranges = $derived(
		[7, 30].map((days) => ({
			label: `${days} days`,
			href: `?days=${days}`,
			current: data.days === days
		}))
	);
</script>

<svelte:head><title>{shortName} · Flared</title></svelte:head>

<p class="back"><a href={appRoutes.app}>← All links</a></p>
<div class="page-head">
	<h1>{data.link.title ?? shortName}</h1>
	{#if data.link.title}<p class="short">{shortName}</p>{/if}
	{#if data.link.blocked}
		<p class="destination">Went to {data.link.destination}</p>
		<p class="badge blocked">{blockLabel(data.link.blocked.reason)}</p>
		<p class="blocked-note">This link is blocked. It does not open, and you cannot change it.</p>
	{:else}
		<p class="destination">
			Goes to <a href={data.link.destination} rel="noopener noreferrer">{data.link.destination}</a>
		</p>
		{#if !data.link.enabled}<p class="badge">Disabled</p>{/if}
	{/if}
</div>

{#if !data.link.blocked}
	<div class="edit">
		<LinkEditForm
			action="?/update"
			link={data.link}
			values={editValues}
			error={editError}
			{notice}
			{pending}
			enhance={enhanceEdit}
		/>
	</div>
{/if}

<div class="qr">
	<LinkQr apiBase="/api/v1" linkId={data.link.id} shortUrl={data.link.shortUrl} />
</div>

{#if data.analytics.status === 'ready'}
	<LinkAnalytics
		analytics={data.analytics.analytics}
		{ranges}
		iconHref={(hostname) => `/api/v1/icons/${hostname}`}
	/>
{:else}
	<section class="notice" role="alert">
		<h2>We couldn’t load the clicks for this link</h2>
		<p>Refresh the page to try again. The link still redirects.</p>
	</section>
{/if}

<style>
	.back {
		margin-bottom: 1rem;
		font-size: 0.85rem;
	}
	.back a {
		color: var(--color-accent-ink);
		font-weight: 600;
	}
	.page-head {
		display: grid;
		gap: 0.3rem;
		margin-bottom: 1.5rem;
	}
	h1 {
		font-size: 1.6rem;
		overflow-wrap: anywhere;
	}
	.short {
		color: var(--color-accent-ink);
		font-weight: 600;
		overflow-wrap: anywhere;
	}
	.edit {
		margin-bottom: 1.5rem;
	}
	.destination {
		overflow: hidden;
		color: var(--color-muted);
		font-size: 0.85rem;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.destination a {
		color: inherit;
		text-decoration: underline;
	}
	.badge {
		justify-self: start;
		padding: 0 0.5rem;
		border: var(--rule);
		border-radius: 999px;
		color: var(--color-muted);
		font-size: 0.75rem;
	}
	.badge.blocked {
		background: var(--color-accent-soft);
		color: var(--color-accent-ink);
	}
	.blocked-note {
		font-size: 0.85rem;
	}
	.qr {
		margin-bottom: 1.5rem;
	}
	.notice {
		display: grid;
		gap: 0.4rem;
		max-width: 44rem;
		padding: 1.25rem;
		border: 1px dashed var(--color-rule);
		border-radius: var(--radius-md);
	}
	.notice h2 {
		font-size: 1.05rem;
	}
	.notice p {
		font-size: 0.9rem;
	}
</style>
