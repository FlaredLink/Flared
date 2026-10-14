<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import ConnectedAppList from '@flared/ui/oauth/ConnectedAppList.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

{#if data.apps}
	<ConnectedAppList
		page={data.apps}
		apiBase="/api/v1"
		mcpUrl={`${page.url.origin}/mcp`}
		onChanged={() => invalidateAll()}
	/>
{:else}
	<section class="notice" role="alert">
		<h2>We couldn’t load your connected apps</h2>
		<p>Refresh the page to try again.</p>
	</section>
{/if}
