<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { Collapsible } from 'bits-ui';
	import type { Usage } from '@flared/contracts/analytics';
	import UsageBanner from '@flared/ui/usage/UsageBanner.svelte';
	import Avatar from '@flared/ui/atoms/Avatar.svelte';
	import Menu from '@flared/ui/molecules/Menu.svelte';
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

	const nav: { label: string; href: string; icon: IconName; current: boolean }[] = $derived([
		{
			label: 'Links',
			href: appRoutes.app,
			icon: 'link',
			current: path === appRoutes.app || path.startsWith('/app/links/')
		},
		{
			label: 'Domains',
			href: appRoutes.domains,
			icon: 'globe',
			current: path === appRoutes.domains
		},
		{
			label: 'Settings',
			href: appRoutes.settings,
			icon: 'settings',
			current: path === appRoutes.settings
		}
	]);

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

{#snippet menu(place: string)}
	<div class="group">
		{#if workspaceName}
			<a class="workspace" href="{appRoutes.settings}#workspace" onclick={() => (open = false)}
				><span class="workspace-initial" aria-hidden="true">{workspaceInitial}</span><span
					class="workspace-name">{workspaceName}</span
				></a
			>
		{/if}
		<nav class="nav" aria-label="App navigation">
			{#each nav as item (item.href)}<a
					href={item.href}
					aria-current={item.current ? 'page' : undefined}
					onclick={() => (open = false)}><Icon name={item.icon} size={22} />{item.label}</a
				>{/each}
		</nav>
	</div>
	<div class="group">
		<div class="account">
			<Menu
				id="account-menu-{place}"
				label="Account {account}"
				text={account}
				class="account-trigger"
				align="start"
				items={[
					{ label: 'Settings', icon: 'gear', href: appRoutes.settings },
					{ label: pending ? 'Signing out…' : 'Sign out', icon: 'signOut', onselect: signOut }
				]}
			>
				{#snippet lead()}<Avatar name={account} size="sm" />{/snippet}
			</Menu>
		</div>
		{#if error}<p class="error" role="alert">{error}</p>{/if}
	</div>
{/snippet}

<div class="app-shell">
	<Collapsible.Root bind:open class="app-sidebar">
		<div class="sidebar-top">
			<a href={appRoutes.app} class="brand-link" aria-label="Flared links"><Brand /></a>
			<Collapsible.Trigger class="menu-toggle" aria-label={open ? 'Close menu' : 'Open menu'}
				><Icon name={open ? 'close' : 'menu'} /></Collapsible.Trigger
			>
		</div>
		<div class="sidebar-body desktop-only">{@render menu('desktop')}</div>
		<Collapsible.Content class="sidebar-body mobile-only"
			>{@render menu('mobile')}</Collapsible.Content
		>
	</Collapsible.Root>
	<main id="main" class="app-main">
		<div class="app-content">
			{#if bannerUsage}<UsageBanner
					usage={bannerUsage}
					href={`${appRoutes.settings}#limits`}
				/>{/if}
			{@render children()}
			<SourceFooter />
		</div>
	</main>
</div>

<style>
	.app-shell {
		min-height: 100svh;
		display: grid;
		grid-template-columns: 15.5rem minmax(0, 1fr);
		background: var(--color-paper);
	}
	:global(.app-sidebar) {
		display: flex;
		flex-direction: column;
		position: sticky;
		top: 0;
		height: 100svh;
		border-right: var(--rule);
		background: var(--color-canvas);
	}
	.sidebar-top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 1.6rem 1.25rem 1.25rem 1.5rem;
	}
	.sidebar-top :global(.brand) {
		font-size: 1.85rem;
	}
	:global(.menu-toggle) {
		display: none;
		place-items: center;
		width: 2.75rem;
		height: 2.75rem;
		border: var(--rule);
		border-radius: var(--radius-control);
		background: var(--color-paper);
	}
	:global(.sidebar-body) {
		flex: 1;
		display: flex;
		flex-direction: column;
		justify-content: space-between;
		gap: 1.5rem;
		padding: 0 0.75rem 1.25rem;
	}
	:global(.sidebar-body.mobile-only) {
		display: none;
	}
	.group {
		display: grid;
		gap: 1rem;
	}
	.workspace {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		min-height: 2.75rem;
		padding: 0 0.75rem;
		border-radius: var(--radius-control);
		color: var(--color-strong);
	}
	.workspace:hover {
		background: var(--color-hover);
	}
	.workspace-initial {
		display: grid;
		flex: none;
		place-items: center;
		width: 1.75rem;
		height: 1.75rem;
		border: 1.5px solid var(--color-strong);
		border-radius: 50%;
		font-size: 0.8125rem;
		font-weight: 650;
	}
	.workspace-name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.nav {
		display: grid;
		gap: 0.375rem;
	}
	.nav a {
		position: relative;
		display: flex;
		align-items: center;
		gap: 0.85rem;
		min-height: 2.75rem;
		padding: 0 0.75rem;
		border-radius: var(--radius-control);
		color: var(--color-ink);
		font-size: 1rem;
	}
	.nav a:hover {
		background: var(--color-hover);
		color: var(--color-strong);
	}
	.nav a[aria-current='page'] {
		background: var(--color-selected);
		color: var(--color-strong);
		font-weight: 600;
	}
	.nav a[aria-current='page']::before {
		content: '';
		position: absolute;
		top: 0;
		bottom: 0;
		left: 0;
		width: 3px;
		border-radius: 3px 0 0 3px;
		background: var(--color-accent);
	}
	.account {
		padding-top: 1rem;
		border-top: var(--rule);
	}
	.account :global(.account-trigger) {
		padding-left: 0.4rem;
		color: var(--color-strong);
		font-size: 0.875rem;
	}
	.error {
		padding-inline: 0.75rem;
		color: var(--color-danger);
		font-size: 0.8125rem;
	}
	.app-main {
		min-width: 0;
		padding: 1.75rem clamp(1.25rem, 3vw, 2.5rem) 3rem;
	}
	.app-content {
		max-width: 92rem;
		margin-inline: auto;
	}
	@media (max-width: 860px) {
		.app-shell {
			grid-template-columns: minmax(0, 1fr);
			grid-template-rows: auto 1fr;
		}
		:global(.app-sidebar) {
			height: auto;
			z-index: 20;
			border-right: 0;
			border-bottom: var(--rule);
		}
		.sidebar-top {
			padding: 0.6rem 1rem;
		}
		.sidebar-top :global(.brand) {
			font-size: 1.5rem;
		}
		:global(.menu-toggle) {
			display: inline-grid;
		}
		:global(.sidebar-body.desktop-only) {
			display: none;
		}
		/* Bits UI sets hidden on the closed menu; display must not override it. */
		:global(.sidebar-body.mobile-only:not([hidden])) {
			display: flex;
			max-height: calc(100svh - 4rem);
			overflow-y: auto;
		}
		.app-main {
			padding-block: 1.25rem 2.5rem;
		}
	}
</style>
