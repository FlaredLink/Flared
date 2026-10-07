<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import DomainList from '@flared/ui/domains/DomainList.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head><title>Domains · Flared</title></svelte:head>

<div class="page-head">
	<h1>Domains</h1>
</div>

{#if data.domains}
	<DomainList page={data.domains} apiBase="/api/v1" onChanged={() => invalidateAll()} />
{:else}
	<section class="notice" role="alert">
		<h2>We couldn’t load your domains</h2>
		<p>Refresh the page to try again.</p>
	</section>
{/if}
