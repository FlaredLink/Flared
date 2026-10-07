<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { Collapsible } from 'bits-ui';
	import type { Usage } from '@flared/contracts/analytics';
	import UsageBanner from '@flared/ui/usage/UsageBanner.svelte';
	import ThemeControl from '@flared/ui/theme/ThemeControl.svelte';
	import Brand from './Brand.svelte';
	import Icon, { type IconName } from './Icon.svelte';
	import SourceFooter from './SourceFooter.svelte';
	import { postJson } from '$lib/auth-client';
	import { appRoutes } from '$lib/routes';

	let {
		account,
		workspaceName,
		usage,
		children
	}: { account: string; workspaceName: string | null; usage: Usage | null; children: Snippet } =
		$props();
	// The tile shows the first letter of the name, as the mockups and most workspace switchers do.
	const workspaceInitial = $derived(
		workspaceName ? (Array.from(workspaceName)[0] ?? '').toLocaleUpperCase() : ''
	);
	// The links and domains pages leave out the domain warning; the domain list shows its own.
	// Settings shows the same usage as meters.
	const path = $derived(page.url.pathname);
	const bannerUsage = $derived.by(() => {
		if (!usage || path === appRoutes.settings) return null;
		const linksOrDomains =
			path === appRoutes.app || path.startsWith('/app/links/') || path === appRoutes.domains;
		return linksOrDomains
			? { ...usage, warnings: usage.warnings.filter((warning) => warning.resource !== 'domains') }
			: usage;
	});
	let open = $state(false);
	let pending = $state(false);
	let error = $state('');

	const nav: { label: string; href: string; icon: IconName }[] = [
		{ label: 'Links', href: appRoutes.app, icon: 'link' },
		{ label: 'Domains', href: appRoutes.domains, icon: 'globe' },
		{ label: 'Settings', href: appRoutes.settings, icon: 'settings' }
	];

	async function signOut() {
		pending = true;
		error = '';
		const result = await postJson('/api/auth/sign-out', {});
		if (!result.ok) {
			pending = false;
			error = 'We could not sign you out. Please try again.';
			return;
		}
		await goto(appRoutes.login, { invalidateAll: true });
	}
</script>

{#snippet menu()}
	<div>
		{#if workspaceName}<a
				class="app-workspace"
				href="{appRoutes.settings}#workspace"
				title="Workspace settings"
				onclick={() => (open = false)}
				><span class="app-workspace-initial" aria-hidden="true">{workspaceInitial}</span><span
					class="app-workspace-name">{workspaceName}</span
				></a
			>{/if}
		<nav class="app-nav" aria-label="App navigation">
			{#each nav as item}<a
					href={item.href}
					aria-current={page.url.pathname === item.href ? 'page' : undefined}
					onclick={() => (open = false)}><Icon name={item.icon} size={18} />{item.label}</a
				>{/each}
		</nav>
	</div>
	<div class="app-account">
		<p class="app-email" title={account}>{account}</p>
		<button class="app-sign-out" type="button" disabled={pending} onclick={() => void signOut()}
			><Icon name="signOut" size={18} />{pending ? 'Signing out…' : 'Sign out'}</button
		>
		{#if error}<p class="app-error" role="alert">{error}</p>{/if}
		<div class="app-theme"><ThemeControl /></div>
	</div>
{/snippet}

<div class="app-shell">
	<Collapsible.Root bind:open class="app-sidebar">
		<div class="app-sidebar-top">
			<a href={appRoutes.app} class="brand-link" aria-label="Flared links"><Brand small /></a>
			<Collapsible.Trigger
				class="app-menu-toggle icon-button"
				aria-label={open ? 'Close menu' : 'Open menu'}
				><Icon name={open ? 'close' : 'menu'} /></Collapsible.Trigger
			>
		</div>
		<div class="app-sidebar-body desktop-only">{@render menu()}</div>
		<Collapsible.Content class="app-sidebar-body mobile-only">{@render menu()}</Collapsible.Content>
	</Collapsible.Root>
	<main id="main" class="app-main">
		{#if bannerUsage}<UsageBanner usage={bannerUsage} href={`${appRoutes.settings}#limits`} />{/if}
		{@render children()}
		<SourceFooter />
	</main>
</div>

<style>
	.app-shell {
		min-height: 100svh;
		display: grid;
		grid-template-columns: 15rem 1fr;
		background: var(--color-paper);
	}
	:global(.app-sidebar) {
		display: flex;
		flex-direction: column;
		position: sticky;
		top: 0;
		height: 100svh;
		border-right: var(--rule);
		background: var(--color-surface);
	}
	.app-sidebar-top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 1rem 1.25rem;
	}
	:global(.app-menu-toggle) {
		display: none;
	}
	:global(.app-sidebar-body) {
		flex: 1;
		display: flex;
		flex-direction: column;
		justify-content: space-between;
		padding: 0.5rem 0.75rem 1rem;
	}
	:global(.app-sidebar-body.mobile-only) {
		display: none;
	}
	.app-workspace {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		min-height: 44px;
		margin-bottom: 0.75rem;
		padding: 0.35rem 0.6rem;
		border: var(--rule);
		border-radius: var(--radius-md);
		color: var(--color-strong);
		font-size: 0.875rem;
		font-weight: 600;
	}
	.app-workspace:hover {
		border-color: var(--color-accent-edge);
	}
	.app-workspace-initial {
		display: grid;
		flex: none;
		place-items: center;
		width: 1.75rem;
		height: 1.75rem;
		border-radius: var(--radius-sm);
		background: var(--color-accent-soft);
		color: var(--color-accent-ink);
		font-size: 0.8rem;
		font-weight: 700;
	}
	.app-workspace-name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.app-nav {
		display: grid;
		gap: 0.15rem;
	}
	.app-nav a {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		min-height: 40px;
		padding: 0 0.75rem;
		border-radius: var(--radius-sm);
		color: var(--color-ink);
		font-size: 0.9rem;
		font-weight: 500;
	}
	.app-nav a:hover {
		background: var(--color-accent-soft);
	}
	.app-nav a[aria-current='page'] {
		background: var(--color-accent-soft);
		color: var(--color-accent-ink);
	}
	.app-account {
		border-top: var(--rule);
		padding: 1rem 0.75rem 0;
	}
	.app-theme {
		margin-top: 0.75rem;
	}
	.app-email {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--color-strong);
		font-size: 0.85rem;
		font-weight: 600;
	}
	.app-sign-out {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-height: 40px;
		margin-top: 0.5rem;
		padding: 0;
		border: 0;
		background: transparent;
		color: var(--color-muted);
		font-size: 0.85rem;
	}
	.app-sign-out:hover:not(:disabled) {
		color: var(--color-strong);
	}
	.app-sign-out:disabled {
		opacity: 1;
	}
	.app-error {
		margin-top: 0.5rem;
		color: var(--color-accent-ink);
		font-size: 0.8rem;
	}
	.app-main {
		min-width: 0;
		padding: 2.5rem clamp(1.25rem, 4vw, 3rem);
	}
	@media (max-width: 860px) {
		.app-shell {
			grid-template-columns: 1fr;
			grid-template-rows: auto 1fr;
		}
		:global(.app-sidebar) {
			position: sticky;
			height: auto;
			z-index: 20;
			border-right: 0;
			border-bottom: var(--rule);
		}
		.app-sidebar-top {
			padding: 0.5rem 1rem;
		}
		:global(.app-menu-toggle) {
			display: inline-flex;
		}
		:global(.app-sidebar-body.desktop-only) {
			display: none;
		}
		:global(.app-sidebar-body.mobile-only) {
			display: flex;
			gap: 1rem;
			padding-inline: 1rem;
		}
		.app-main {
			padding-block: 1.75rem;
		}
	}
</style>
