<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import ConsentCard from '@flared/ui/oauth/ConsentCard.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const view = $derived(data.state);
</script>

<svelte:head><title>Connect an app · Flared</title></svelte:head>

<section class="consent-page" aria-live="polite">
	<div class="consent-frame">
		{#if view.status === 'ready'}
			<ConsentCard request={view.request} oauthQuery={view.oauthQuery} account={view.account} />
		{:else}
			<p class="eyebrow">Connect an app</p>
			<h1>
				{view.status === 'workspace'
					? 'Your workspace is not ready'
					: 'This request can’t continue'}
			</h1>
			<p>
				{#if view.status === 'expired'}
					This request has expired. Start the connection again in the app.
				{:else if view.status === 'invalid'}
					The app sent a request that Flared can’t accept. Check the server URL you added, then try
					again.
				{:else if view.status === 'workspace'}
					We are still setting up your workspace. Try again in a moment.
				{:else}
					Connecting apps isn’t available right now. Try again later.
				{/if}
			</p>
			<a class="button secondary" href="/app">Go to Flared</a>
		{/if}
	</div>
</section>

<style>
	.consent-page {
		min-height: 64svh;
		display: grid;
		place-items: center;
		padding-block: 4rem;
	}
	.consent-frame {
		display: grid;
		gap: 0.8rem;
		width: min(100%, 32rem);
		padding: 2rem;
		border: var(--rule);
		border-radius: var(--radius-md);
		background: var(--color-paper);
		box-shadow: var(--shadow-float);
	}
	h1 {
		font-size: clamp(1.6rem, 4vw, 2rem);
	}
	.button {
		justify-self: start;
		margin-top: 0.5rem;
	}
</style>
