<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import DomainList from '@flared/ui/domains/DomainList.svelte';
	import PageHeader from '@flared/ui/molecules/PageHeader.svelte';
	import Callout from '@flared/ui/molecules/Callout.svelte';
	import { appRoutes } from '$lib/routes';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head><title>Domains · Flared</title></svelte:head>

{#if data.domains}
	<DomainList
		page={data.domains}
		apiBase="/api/v1"
		onChanged={() => invalidateAll()}
		createHref={appRoutes.app}
	/>
{:else}
	<PageHeader title="Domains" lead="Use a familiar address for every link." />
	<Callout tone="danger" role="alert" title="We couldn’t load your domains">
		<p>Refresh the page to try again.</p>
	</Callout>
{/if}
