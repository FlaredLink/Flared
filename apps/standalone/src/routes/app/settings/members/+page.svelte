<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import Members from '@flared/ui/workspace/Members.svelte';
	import { appRoutes } from '$lib/routes';
	import { useSettings } from '$lib/settings';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const settings = useSettings();
	// The owner invites and removes; a member sees the list and can leave.
	const owner = $derived(data.workspace?.role === 'owner');
</script>

<div id="members" class="anchor">
	{#if data.members && data.workspaceName !== null}
		<Members
			page={data.members}
			apiBase="/api/v1"
			delivery="link"
			onChanged={() => invalidateAll()}
			workspaceName={data.workspaceName}
			{owner}
			onLeft={() => goto(appRoutes.login, { invalidateAll: true })}
			onReauthRequired={settings.askReauth}
		/>
	{:else}
		<section class="notice" role="alert">
			<h2>We couldn’t load the members</h2>
			<p>Refresh the page to try again.</p>
		</section>
	{/if}
</div>
