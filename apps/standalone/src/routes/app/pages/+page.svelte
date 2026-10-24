<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import { goto } from '$app/navigation';
	import PageList from '@flared/ui/pages/PageList.svelte';
	import PageHeader from '@flared/ui/molecules/PageHeader.svelte';
	import Callout from '@flared/ui/molecules/Callout.svelte';
	import { pageRoute } from '$lib/routes';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head><title>Pages · Flared</title></svelte:head>

{#if data.pages}
	<PageList
		list={data.pages}
		apiBase="/api/v1"
		editHref={(page) => pageRoute(page.id)}
		onCreated={(page, template) =>
			goto(
				template === 'blank' ? pageRoute(page.id) : `${pageRoute(page.id)}?template=${template}`
			)}
	/>
{:else}
	<PageHeader title="Pages" />
	<Callout tone="danger" role="alert" title="We couldn’t load your pages">
		<p>Refresh the page to try again.</p>
	</Callout>
{/if}
