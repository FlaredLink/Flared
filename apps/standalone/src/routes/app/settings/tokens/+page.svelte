<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import TokenList from '@flared/ui/tokens/TokenList.svelte';
	import { useSettings } from '$lib/settings';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const settings = useSettings();
</script>

{#if data.tokens}
	<TokenList
		page={data.tokens}
		apiBase="/api/v1"
		onChanged={() => invalidateAll()}
		onReauthRequired={settings.askReauth}
	/>
{:else}
	<section class="notice" role="alert">
		<h2>We couldn’t load your API tokens</h2>
		<p>Refresh the page to try again.</p>
	</section>
{/if}
