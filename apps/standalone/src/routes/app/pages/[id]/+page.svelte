<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import { beforeNavigate, goto, invalidateAll } from '$app/navigation';
	import PageAnalytics from '@flared/ui/pages/PageAnalytics.svelte';
	import PageEditor from '@flared/ui/pages/PageEditor.svelte';
	import PageQr from '@flared/ui/pages/PageQr.svelte';
	import PageTopBar, { type PageViewLink } from '@flared/ui/pages/PageTopBar.svelte';
	import Callout from '@flared/ui/molecules/Callout.svelte';
	import { appRoutes, linkRoute, pageRoute } from '$lib/routes';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	let dirty = $state(false);
	// Only the editor has a draft; the other views have nothing to lose.
	$effect(() => {
		if (data.view !== 'edit') dirty = false;
	});

	// Unsaved changes ask before the person leaves; a tab close gets the browser's own question.
	beforeNavigate(({ cancel, type }) => {
		if (!dirty) return;
		if (type === 'leave') cancel();
		else if (!confirm('Leave without saving your changes?')) cancel();
	});

	const address = $derived(data.page.domainUrl ?? data.page.url);
	const ranges = $derived(
		[7, 30].map((days) => ({
			label: `${days} days`,
			href: days === 7 ? '?view=analytics&days=7' : '?view=analytics',
			current: data.days === days
		}))
	);
	const views = $derived<PageViewLink[]>([
		{ label: 'Edit', href: pageRoute(data.page.id), current: data.view === 'edit' },
		{ label: 'Analytics', href: '?view=analytics', current: data.view === 'analytics' },
		{ label: 'QR code', href: '?view=qr', current: data.view === 'qr' }
	]);

	async function saved() {
		// The template only fills a new page once; after a save, the address drops it.
		if (data.template)
			await goto(pageRoute(data.page.id), { replaceState: true, noScroll: true, keepFocus: true });
		else await invalidateAll();
	}
</script>

<svelte:head><title>{data.page.title} · Pages · Flared</title></svelte:head>

<PageTopBar
	apiBase="/api/v1"
	page={data.page}
	crumbs={[{ label: 'Pages', href: appRoutes.pages }, { label: data.page.title }]}
	backHref={appRoutes.pages}
	{views}
	onchanged={() => invalidateAll()}
	ondeleted={() => goto(appRoutes.pages, { invalidateAll: true })}
/>

{#if data.view === 'edit'}
	<PageEditor
		apiBase="/api/v1"
		page={data.page}
		domains={data.domains}
		template={data.template}
		bind:dirty
		onsaved={() => void saved()}
	/>
{:else if data.view === 'analytics'}
	{#if data.analytics?.status === 'ready'}
		<PageAnalytics
			analytics={data.analytics.analytics}
			{ranges}
			navigate={(href) => goto(href, { noScroll: true, keepFocus: true })}
			iconHref={(hostname) => `/api/v1/icons/${hostname}`}
			linkHref={linkRoute}
		/>
	{:else}
		<Callout tone="danger" role="alert" title="We couldn’t load the views for this page">
			<p>Refresh the page to try again. The page still shows.</p>
		</Callout>
	{/if}
{:else if address}
	<PageQr {address} fileName={data.page.handle} />
{:else}
	<Callout title="This page has no address yet">
		<p>Choose a domain in the editor. The QR code opens the page at that address.</p>
	</Callout>
{/if}
