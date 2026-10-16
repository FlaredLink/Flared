<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import WebhookList from '@flared/ui/webhooks/WebhookList.svelte';
	import { settingsRoutes } from '$lib/routes';
	import { useSettings } from '$lib/settings';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const settings = useSettings();
</script>

{#if data.workspace && data.workspace.role !== 'owner'}
	<section class="notice">
		<h2>Webhooks</h2>
		<p>Only the workspace owner can add or change webhook endpoints.</p>
	</section>
{:else if data.webhooks}
	<WebhookList
		page={data.webhooks}
		apiBase="/api/v1"
		canManage
		onReauthRequired={settings.askReauth}
	>
		{#snippet limitNotice()}
			<p>
				The webhook endpoint limit is 0, so webhooks are off.
				<a href={settingsRoutes.limits}>Change it in Limits and usage</a>
			</p>
		{/snippet}
	</WebhookList>
{:else}
	<section class="notice" role="alert">
		<h2>We couldn’t load your webhooks</h2>
		<p>Refresh the page to try again.</p>
	</section>
{/if}
