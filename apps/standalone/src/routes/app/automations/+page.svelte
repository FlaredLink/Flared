<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import AutomationList from '@flared/ui/automations/AutomationList.svelte';
	import PageHeader from '@flared/ui/molecules/PageHeader.svelte';
	import Callout from '@flared/ui/molecules/Callout.svelte';
	import { settingsRoutes } from '$lib/routes';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head><title>Automations · Flared</title></svelte:head>

{#if data.automations}
	<AutomationList
		page={data.automations}
		apiBase="/api/v1"
		canManage={data.workspace?.role === 'owner'}
		endpoints={data.endpoints}
		webhooksHref={settingsRoutes.webhooks}
	>
		{#snippet limitNotice()}
			<p>
				The automation limit is 0, so automations are off.
				<a href={settingsRoutes.limits}>Change it in Limits and usage</a>
			</p>
		{/snippet}
	</AutomationList>
{:else}
	<PageHeader title="Automations" lead="Templates you apply to links from the Links page." />
	<Callout tone="danger" role="alert" title="We couldn’t load your automations">
		<p>Refresh the page to try again.</p>
	</Callout>
{/if}
