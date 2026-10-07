<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import '../app.css';
	import type { Snippet } from 'svelte';
	import AuthFrame from '$lib/components/AuthFrame.svelte';
	import type { LayoutData } from './$types';

	let { data, children }: { data: LayoutData; children: Snippet } = $props();
</script>

<svelte:head>
	{#if data.installation.state === 'closed'}<title>Installation closed · Flared</title>{/if}
</svelte:head>

<a class="skip-link" href="#main">Skip to content</a>
{#if data.installation.state === 'closed'}
	<AuthFrame>
		<section class="card" aria-labelledby="closed-heading">
			<p class="eyebrow">Flared</p>
			<h1 id="closed-heading">This installation is closed</h1>
			<p>
				The owner deleted the workspace, so its links and data are gone. This installation never
				opens again.
			</p>
			<p>
				To use Flared again, deploy a new copy with new databases. See
				<code>docs/self-hosting/deploy.md</code> in the repository.
			</p>
		</section>
	</AuthFrame>
{:else}
	{@render children()}
{/if}
