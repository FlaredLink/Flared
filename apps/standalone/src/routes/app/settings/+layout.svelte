<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import { onMount, tick, type Snippet } from 'svelte';
	import { goto, invalidateAll } from '$app/navigation';
	import { navigating, page } from '$app/state';
	import PageHeader from '@flared/ui/molecules/PageHeader.svelte';
	import SettingsNav, { type SettingsGroup } from '@flared/ui/molecules/SettingsNav.svelte';
	import Badge from '@flared/ui/atoms/Badge.svelte';
	import {
		confirmWithPasskey,
		passkeyErrorMessage,
		passkeysSupported
	} from '@flared/ui/passkeys/client';
	import { authErrorMessage, postJson } from '$lib/auth-client';
	import { settingsRoutes } from '$lib/routes';
	import { provideSettings } from '$lib/settings';
	import type { LayoutData } from './$types';

	let { data, children }: { data: LayoutData; children: Snippet } = $props();

	const account = $derived(
		data.auth.status === 'authenticated' ? data.auth.principal.user.name : ''
	);
	const owner = $derived(data.workspace?.role === 'owner');
	const workspaceName = $derived(data.workspaceName ?? 'this workspace');

	// Account sections apply to the person; workspace sections apply to the workspace. Update
	// checks are the owner's alone.
	const accountLead = 'Applies to your account.';
	const workspaceLead = $derived(`Applies to ${workspaceName}.`);
	const leads: Record<string, string> = $derived({
		[settingsRoutes.account]: accountLead,
		[settingsRoutes.security]: accountLead,
		[settingsRoutes.preferences]: 'Applies to this browser on this device.',
		[settingsRoutes.workspace]: workspaceLead,
		[settingsRoutes.members]: workspaceLead,
		[settingsRoutes.limits]: workspaceLead,
		[settingsRoutes.updates]: 'Applies to this installation.',
		[settingsRoutes.tokens]: `Your tokens for ${workspaceName}. Other members cannot see them.`,
		[settingsRoutes.webhooks]: workspaceLead,
		[settingsRoutes.apps]: `Your connected apps in ${workspaceName}. Other members cannot see them.`
	});
	const groups: SettingsGroup[] = $derived([
		{
			id: 'account',
			label: 'Account',
			sections: [
				{ href: settingsRoutes.account, label: 'Profile', icon: 'userCircle' },
				{ href: settingsRoutes.security, label: 'Security', icon: 'shield' },
				{ href: settingsRoutes.preferences, label: 'Preferences', icon: 'sun' }
			]
		},
		{
			id: 'workspace',
			label: 'Workspace',
			detail: workspaceName,
			sections: [
				{ href: settingsRoutes.workspace, label: 'General', icon: 'gear' },
				{ href: settingsRoutes.members, label: 'Members', icon: 'users' },
				{ href: settingsRoutes.limits, label: 'Limits and usage', icon: 'chart' },
				...(owner
					? [{ href: settingsRoutes.updates, label: 'Updates', icon: 'download' as const }]
					: []),
				{ href: settingsRoutes.tokens, label: 'API tokens', icon: 'key' },
				{ href: settingsRoutes.webhooks, label: 'Webhooks', icon: 'lightning' },
				{ href: settingsRoutes.apps, label: 'Connected apps', icon: 'plugs' }
			]
		}
	]);
	const path = $derived(page.url.pathname);
	const current = $derived(
		groups.flatMap((group) => group.sections).find((section) => section.href === path) ??
			groups[0].sections[0]
	);
	// The section list marks the section being opened at once; the heading follows its data.
	const selected = $derived(
		groups
			.flatMap((group) => group.sections)
			.find((section) => section.href === navigating.to?.url.pathname)?.href ?? current.href
	);
	const inWorkspace = $derived(groups[1].sections.some((section) => section.href === path));

	// Links from before the sections point at an anchor of the single Settings page. The redirect
	// keeps the anchor; open the section that holds it.
	const anchorRoutes: Record<string, string> = {
		'#workspace': settingsRoutes.workspace,
		'#export': settingsRoutes.workspace,
		'#members': settingsRoutes.members,
		'#limits': settingsRoutes.limits,
		'#updates': settingsRoutes.updates
	};
	function openAnchor(hash: string) {
		const target = anchorRoutes[hash];
		if (target && target !== path) void goto(`${target}${hash}`, { replaceState: true });
	}

	// Confirming it's you: the password, or a passkey of this account.
	let reauthOpen = $state(false);
	let reauthPassword = $state('');
	let reauthPending = $state(false);
	let reauthError = $state('');
	let reauthHeading = $state<HTMLHeadingElement>();
	let supported = $state(false);
	const canUsePasskey = $derived(supported && (data.passkeys?.passkeys.length ?? 0) > 0);

	onMount(() => {
		supported = passkeysSupported();
		openAnchor(window.location.hash);
	});

	// The panel sits at the top of the section, so bring it into view from the control that asked.
	async function askReauth() {
		reauthOpen = true;
		await tick();
		reauthHeading?.scrollIntoView({ block: 'center' });
		reauthHeading?.focus({ preventScroll: true });
	}

	provideSettings({
		askReauth: () => void askReauth(),
		// Without the passkey list the page cannot tell, so the server decides and asks.
		fresh: () =>
			data.passkeys === null ||
			(data.passkeys.freshUntil !== null && Date.parse(data.passkeys.freshUntil) > Date.now())
	});

	async function confirmPassword() {
		reauthPending = true;
		reauthError = '';
		const result = await postJson('/api/auth/reauth/password', { password: reauthPassword });
		reauthPending = false;
		if (!result.ok) {
			reauthError = authErrorMessage(result.code);
			return;
		}
		reauthPassword = '';
		reauthOpen = false;
		await invalidateAll();
	}

	async function confirmPasskey() {
		reauthPending = true;
		reauthError = '';
		const result = await confirmWithPasskey();
		reauthPending = false;
		if (!result.ok) {
			reauthError = passkeyErrorMessage(result.code);
			return;
		}
		reauthOpen = false;
		await invalidateAll();
	}
</script>

<svelte:window onhashchange={() => openAnchor(window.location.hash)} />

<svelte:head><title>{current.label} settings · Flared</title></svelte:head>

<PageHeader
	crumbs={inWorkspace
		? [{ label: data.workspaceName ?? 'Workspace' }, { label: 'Settings' }]
		: [{ label: 'Account' }, { label: 'Settings' }]}
	title={current.label}
	lead={leads[current.href]}
>
	{#snippet top()}
		{#if inWorkspace}
			<span class="scope"
				>{workspaceName}
				{#if data.workspace}<Badge tone={owner ? 'accent' : 'neutral'}
						>{owner ? 'Owner' : 'Member'}</Badge
					>{/if}</span
			>
		{:else if account}
			<span class="scope">Signed in as {account}</span>
		{/if}
	{/snippet}
</PageHeader>

<div class="settings">
	<SettingsNav {groups} current={selected} onselect={(href) => void goto(href)} />

	<div class="content">
		{#if reauthOpen}
			<section class="section reauth" aria-labelledby="reauth-heading">
				<h2 id="reauth-heading" tabindex="-1" bind:this={reauthHeading}>Confirm it’s you</h2>
				<p>
					Changing credentials, limits, and webhook secrets needs a sign-in from the last 10
					minutes. Enter your password{canUsePasskey ? ' or use a passkey' : ''}.
				</p>
				<form
					class="field"
					onsubmit={(event) => {
						event.preventDefault();
						void confirmPassword();
					}}
				>
					<label for="reauth-password">Password</label>
					<input
						id="reauth-password"
						type="password"
						bind:value={reauthPassword}
						required
						autocomplete="current-password"
					/>
					<div class="button-row">
						<button class="button primary" type="submit" disabled={reauthPending}>Confirm</button>
						{#if canUsePasskey}
							<button
								class="button secondary"
								type="button"
								disabled={reauthPending}
								onclick={() => void confirmPasskey()}>Use a passkey</button
							>
						{/if}
						<button class="button secondary" type="button" onclick={() => (reauthOpen = false)}
							>Cancel</button
						>
					</div>
				</form>
				{#if reauthError}<p class="error" role="alert">{reauthError}</p>{/if}
			</section>
		{/if}
		{@render children()}
	</div>
</div>

<style>
	.scope {
		display: inline-flex;
		align-items: center;
		gap: 0.6rem;
		color: var(--color-strong);
		font-size: 0.9375rem;
		font-weight: 500;
	}
	.settings {
		display: grid;
		grid-template-columns: 13rem minmax(0, 1fr);
		align-items: start;
		gap: 2.5rem;
	}
	.content {
		display: grid;
		gap: 2.25rem;
		min-width: 0;
	}
	.content :global(.anchor) {
		scroll-margin-top: 1.5rem;
	}
	.reauth {
		padding: 1.25rem;
		border: var(--rule);
		border-radius: var(--radius-md);
	}
	/* SettingsNav swaps its list for a select at the same width. */
	@media (max-width: 64rem) {
		.settings {
			grid-template-columns: minmax(0, 1fr);
			gap: 1.75rem;
		}
	}
</style>
