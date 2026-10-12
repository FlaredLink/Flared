<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import { page } from '$app/state';
	import type { Snippet } from 'svelte';
	import AuthFrame from '$lib/components/AuthFrame.svelte';
	import Shell from '$lib/components/Shell.svelte';
	import { provideShownWorkspace } from '@flared/ui/workspace/shown';
	import type { LayoutData } from './$types';

	let { data, children }: { data: LayoutData; children: Snippet } = $props();
	// Invite and reset links open on their own, whoever is signed in.
	const signInPage = $derived(
		page.route.id === '/app/login' ||
			page.route.id === '/app/oauth/consent' ||
			page.route.id === '/app/invite' ||
			page.route.id === '/app/reset'
	);
	provideShownWorkspace(() => data.workspace?.id ?? null);
</script>

{#if data.auth.status === 'authenticated' && !signInPage}
	<Shell
		account={data.auth.principal.user.name}
		workspaceName={data.workspaceName}
		usage={data.usage}>{@render children()}</Shell
	>
{:else}
	<AuthFrame>{@render children()}</AuthFrame>
{/if}
