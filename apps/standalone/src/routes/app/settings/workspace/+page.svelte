<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import ExportPanel from '@flared/ui/export/ExportPanel.svelte';
	import WorkspaceName from '@flared/ui/workspace/WorkspaceName.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	// The owner changes the name; a member sees it.
	const owner = $derived(data.workspace?.role === 'owner');
</script>

{#if data.workspaceName !== null}
	<div id="workspace" class="anchor">
		<WorkspaceName
			apiBase="/api/v1"
			name={data.workspaceName}
			onRenamed={invalidateAll}
			editable={owner}
		/>
	</div>
{/if}
<div id="export" class="anchor">
	<ExportPanel apiBase="/api/v1" retentionDays={data.usage?.retentionDays ?? null} />
</div>
