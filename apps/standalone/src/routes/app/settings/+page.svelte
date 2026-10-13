<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import ConnectedAppList from '@flared/ui/oauth/ConnectedAppList.svelte';
	import DeleteAccount from '@flared/ui/account/DeleteAccount.svelte';
	import ExportPanel from '@flared/ui/export/ExportPanel.svelte';
	import PasskeyList from '@flared/ui/passkeys/PasskeyList.svelte';
	import TokenList from '@flared/ui/tokens/TokenList.svelte';
	import UsageMeters from '@flared/ui/usage/UsageMeters.svelte';
	import Members from '@flared/ui/workspace/Members.svelte';
	import WorkspaceName from '@flared/ui/workspace/WorkspaceName.svelte';
	import ThemeSetting from '@flared/ui/theme/ThemeSetting.svelte';
	import PageHeader from '@flared/ui/molecules/PageHeader.svelte';
	import SectionHeader from '@flared/ui/molecules/SectionHeader.svelte';
	import Callout from '@flared/ui/molecules/Callout.svelte';
	import CopyButton from '@flared/ui/molecules/CopyButton.svelte';
	import Checkbox from '@flared/ui/atoms/Checkbox.svelte';
	import {
		confirmWithPasskey,
		passkeyErrorMessage,
		passkeysSupported
	} from '@flared/ui/passkeys/client';
	import { authErrorMessage, postJson } from '$lib/auth-client';
	import { limitFields, toLimitsView, type Limits } from '$lib/limits';
	import { appRoutes } from '$lib/routes';
	import { availableRelease } from '$lib/updates';
	import upgradeWorkflow from '../../../../../../deploy/flared-upgrade.yml?raw';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const account = $derived(
		data.auth.status === 'authenticated' ? data.auth.principal.user.name : ''
	);
	const numbers = new Intl.NumberFormat();
	// The owner changes the name, members, and limits; a member sees them.
	const owner = $derived(data.workspace?.role === 'owner');

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
	});

	// The panel sits at the top of the page, so bring it into view from the section that asked.
	async function askReauth() {
		reauthOpen = true;
		await tick();
		reauthHeading?.scrollIntoView({ block: 'center' });
		reauthHeading?.focus({ preventScroll: true });
	}

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

	// Password change.
	let currentPassword = $state('');
	let newPassword = $state('');
	let repeatPassword = $state('');
	let passwordPending = $state(false);
	let passwordMessage = $state('');
	let passwordError = $state('');

	async function changePassword() {
		passwordError = '';
		passwordMessage = '';
		if (newPassword !== repeatPassword) {
			passwordError = 'The new passwords do not match.';
			return;
		}
		passwordPending = true;
		const result = await postJson('/api/auth/password/change', { currentPassword, newPassword });
		passwordPending = false;
		if (!result.ok) {
			if (result.code === 'REAUTH_REQUIRED') return askReauth();
			passwordError =
				result.code === 'INVALID_REQUEST'
					? 'Use a new password of 12 to 128 characters.'
					: authErrorMessage(result.code);
			return;
		}
		currentPassword = '';
		newPassword = '';
		repeatPassword = '';
		passwordMessage = 'Your password changed. Every other session ended.';
		await invalidateAll();
	}

	// Limits.
	let limits = $state<Limits | null>(null);
	let limitsView = $state<PageData['limits']>(null);
	let limitsPending = $state(false);
	let limitsError = $state('');
	$effect(() => {
		limitsView = data.limits;
		limits = data.limits ? { ...data.limits.limits } : null;
	});

	async function saveLimits() {
		if (!limits) return;
		limitsPending = true;
		limitsError = '';
		try {
			const response = await fetch('/api/settings/limits', {
				method: 'POST',
				credentials: 'same-origin',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(limits)
			});
			const body: unknown = await response.json().catch(() => null);
			if (response.ok) {
				limitsView = toLimitsView(body) ?? limitsView;
				await invalidateAll();
				return;
			}
			const error =
				typeof body === 'object' && body !== null && 'error' in body ? body.error : null;
			const code =
				typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
			if (code === 'REAUTH_REQUIRED') return askReauth();
			limitsError =
				code === 'VALIDATION_FAILED'
					? 'Each limit must be a whole number in its range.'
					: 'We could not change the limits. Try again.';
		} catch {
			limitsError = 'We could not reach the app. Try again.';
		} finally {
			limitsPending = false;
		}
	}

	// Update checks: only the owner sees and changes them.
	const times = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
	const release = $derived(availableRelease(data.updates, __FLARED_VERSION__));
	const upgradeCommands = $derived(
		release ? `git fetch upstream --tags\ngit merge v${release.version}\ngit push` : ''
	);
	let updatesEnabled = $state(false);
	let updatesPending = $state(false);
	let updatesError = $state('');
	$effect(() => {
		updatesEnabled = data.updates?.enabled ?? false;
	});

	async function changeUpdates(enabled: boolean) {
		updatesPending = true;
		updatesError = '';
		const result = await postJson('/api/settings/updates', { enabled });
		updatesPending = false;
		if (!result.ok) {
			updatesEnabled = !enabled;
			updatesError = 'We could not save your choice. Try again.';
			return;
		}
		await invalidateAll();
	}

	function megabytes(bytes: number): string {
		return `${numbers.format(Math.round((bytes / 1_000_000) * 10) / 10)} MB`;
	}
</script>

<svelte:head><title>Settings · Flared</title></svelte:head>

<PageHeader
	crumbs={[{ label: data.workspaceName ?? 'Workspace' }, { label: 'Settings' }]}
	title="Settings"
	lead={account ? `Signed in as ${account}` : 'Your account, preferences, and access.'}
/>

{#if reauthOpen}
	<section class="section reauth" aria-labelledby="reauth-heading">
		<h2 id="reauth-heading" tabindex="-1" bind:this={reauthHeading}>Confirm it’s you</h2>
		<p>
			Changing credentials and limits needs a sign-in from the last 10 minutes. Enter your password{canUsePasskey
				? ' or use a passkey'
				: ''}.
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
	<div class="divider"></div>
{/if}

<section class="group" aria-labelledby="general-heading">
	<SectionHeader id="general-heading" title="General" />
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
	<ThemeSetting />
</section>

<div class="divider"></div>

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
			onReauthRequired={() => void askReauth()}
		/>
	{:else}
		<section class="notice" role="alert">
			<h2>We couldn’t load the members</h2>
			<p>Refresh the page to try again.</p>
		</section>
	{/if}
</div>

<div class="divider"></div>

<section class="section" aria-labelledby="password-heading">
	<h2 id="password-heading">Password</h2>
	<p>
		Changing your password ends every other session. {owner
			? 'Without email, a forgotten password is reset from the Cloudflare account.'
			: 'If you forget it, ask the workspace owner for a password reset link.'}
	</p>
	<form
		class="password-form"
		onsubmit={(event) => {
			event.preventDefault();
			void changePassword();
		}}
	>
		<div class="field">
			<label for="current-password">Current password</label>
			<input
				id="current-password"
				type="password"
				bind:value={currentPassword}
				required
				autocomplete="current-password"
			/>
		</div>
		<div class="field">
			<label for="new-password">New password</label>
			<input
				id="new-password"
				type="password"
				bind:value={newPassword}
				required
				minlength="12"
				maxlength="128"
				autocomplete="new-password"
			/>
		</div>
		<div class="field">
			<label for="repeat-password">New password again</label>
			<input
				id="repeat-password"
				type="password"
				bind:value={repeatPassword}
				required
				autocomplete="new-password"
			/>
		</div>
		{#if passwordError}<p class="error" role="alert">{passwordError}</p>{/if}
		{#if passwordMessage}<p role="status">{passwordMessage}</p>{/if}
		<button class="button primary" type="submit" disabled={passwordPending}
			>{passwordPending ? 'Changing…' : 'Change password'}</button
		>
	</form>
</section>

<div class="divider"></div>

<SectionHeader title="Passkeys" />
{#if data.passkeys}
	<PasskeyList
		page={data.passkeys}
		onChanged={() => invalidateAll()}
		onReauthRequired={() => void askReauth()}
	/>
{:else}
	<section class="notice" role="alert">
		<h2>We couldn’t load your passkeys</h2>
		<p>Refresh the page to try again.</p>
	</section>
{/if}

<div class="divider"></div>

{#if data.tokens}
	<TokenList
		page={data.tokens}
		apiBase="/api/v1"
		onChanged={() => invalidateAll()}
		onReauthRequired={() => void askReauth()}
	/>
{:else}
	<section class="notice" role="alert">
		<h2>We couldn’t load your API tokens</h2>
		<p>Refresh the page to try again.</p>
	</section>
{/if}

<div class="divider"></div>

{#if data.apps}
	<ConnectedAppList
		page={data.apps}
		apiBase="/api/v1"
		mcpUrl={`${page.url.origin}/mcp`}
		onChanged={() => invalidateAll()}
	/>
{:else}
	<section class="notice" role="alert">
		<h2>We couldn’t load your connected apps</h2>
		<p>Refresh the page to try again.</p>
	</section>
{/if}

<div class="divider"></div>

<section id="limits" class="section anchor" aria-labelledby="limits-heading">
	<h2 id="limits-heading">Limits and usage</h2>
	{#if data.usage}<UsageMeters usage={data.usage} />{/if}
	{#if limits && limitsView}
		<p>
			{owner
				? 'Lower limits never stop existing links, domains, or members; they block new ones. Higher limits use more of your Cloudflare plan; see docs/self-hosting/limits.md.'
				: 'Only the workspace owner can change the limits.'}
		</p>
		<form
			class="limits-form"
			onsubmit={(event) => {
				event.preventDefault();
				void saveLimits();
			}}
		>
			{#each limitFields as field}
				<div class="field">
					<label for={`limit-${field.key}`}>{field.label}</label>
					<input
						id={`limit-${field.key}`}
						type="number"
						inputmode="numeric"
						min={limitsView.bounds[field.key].min}
						max={limitsView.bounds[field.key].max}
						step="1"
						required
						readonly={!owner}
						bind:value={limits[field.key]}
					/>
					<small
						>{numbers.format(limitsView.bounds[field.key].min)} to {numbers.format(
							limitsView.bounds[field.key].max
						)}
						{field.unit}</small
					>
				</div>
			{/each}
			{#if limitsError}<p class="error" role="alert">{limitsError}</p>{/if}
			<div class="button-row">
				{#if owner}
					<button class="button primary" type="submit" disabled={limitsPending}
						>{limitsPending ? 'Saving…' : 'Save limits'}</button
					>
				{/if}
				{#if limitsView.pending}
					<p role="status">
						Pending: the new limits are saved and apply once both databases hold them.
						<button class="link-button" type="button" onclick={() => invalidateAll()}
							>Check again</button
						>
					</p>
				{/if}
			</div>
		</form>
		{#if limitsView.analyticsBytes !== null}
			<p>
				The analytics database uses {megabytes(limitsView.analyticsBytes)}. One D1 database holds up
				to 500 MB on Workers Free and 10 GB on Workers Paid. Workers Free also limits D1 reads, D1
				writes, and Queue operations each day.
			</p>
		{/if}
	{:else}
		<section class="notice" role="alert">
			<h2>We couldn’t load the limits</h2>
			<p>Refresh the page to try again.</p>
		</section>
	{/if}
</section>

{#if owner && data.updates}
	<div class="divider"></div>

	<section id="updates" class="section anchor" aria-labelledby="updates-heading">
		<h2 id="updates-heading">Updates</h2>
		<p>
			{__FLARED_VERSION__
				? `This app runs Flared ${__FLARED_VERSION__}.`
				: 'This copy does not name its Flared version.'}
		</p>
		<Checkbox
			bind:checked={updatesEnabled}
			disabled={updatesPending}
			onchange={() => void changeUpdates(updatesEnabled)}
			hint="Once a day, the app asks flared.page for the latest release. The request sends no data about this installation."
			>Check for updates</Checkbox
		>
		{#if updatesPending}<p role="status">{updatesEnabled ? 'Checking…' : 'Saving…'}</p>{/if}
		{#if updatesError}<p class="error" role="alert">{updatesError}</p>{/if}
		{#if data.updates.enabled && !updatesPending}
			{#if release}
				<Callout tone="info" icon="download" title={`Flared ${release.version} is available`}>
					<p>{release.summary}</p>
					{#if release.breaking}
						<p>
							This release changes how something works. Read the release notes before you upgrade.
						</p>
					{/if}
					{#if release.migrations}
						<p>
							It changes the databases, and older code cannot undo that. Before you upgrade, note
							the time for a Time Travel restore.
						</p>
					{/if}
					<p><a href={release.notesUrl} rel="noopener">Release notes</a></p>
				</Callout>
				<h3 class="upgrade-heading">Upgrade</h3>
				<p>
					In your copy of the repository, merge the release and push. Workers Builds deploys it and
					applies the database changes first.
				</p>
				<div class="commands">
					<pre><code>{upgradeCommands}</code></pre>
					<CopyButton text={upgradeCommands} label="Copy the commands" kind="button" size="sm" />
				</div>
				<p>
					For the first upgrade, add the Flared remote and record the version your copy came from.
					The <a
						href={`https://github.com/FlaredLink/Flared/blob/v${release.version}/docs/self-hosting/upgrade.md`}
						rel="noopener">upgrade guide</a
					> has the steps.
				</p>
			{:else if data.updates.checkedAt !== null}
				<p>
					{__FLARED_VERSION__ ? 'This is the latest release.' : 'No newer release was found.'} Last checked
					{times.format(data.updates.checkedAt)}.
				</p>
			{/if}
			{#if data.updates.failedAt !== null}
				<p role="status">
					We could not check for updates on {times.format(data.updates.failedAt)}. The app tries
					again each day.
				</p>
			{/if}
		{/if}
		<details class="workflow">
			<summary>Upgrade with a GitHub workflow</summary>
			<p>
				The workflow checks for a new release each day. It opens a pull request that merges the
				release into your repository, or an issue when you must act. Set it up once:
			</p>
			<ol>
				<li>
					Add this file to your repository as <code>.github/workflows/flared-upgrade.yml</code>.
				</li>
				<li>
					In the repository settings, open <strong>Actions → General</strong> and allow GitHub Actions
					to create and approve pull requests.
				</li>
				<li>
					Optional: add the repository variable <code>FLARED_AUTO_UPGRADE</code> with the value
					<code>true</code>. The workflow then merges each upgrade that merges cleanly and is not
					marked breaking, and Workers Builds deploys it.
				</li>
			</ol>
			<div class="commands">
				<pre><code>{upgradeWorkflow}</code></pre>
				<CopyButton text={upgradeWorkflow} label="Copy the workflow" kind="button" size="sm" />
			</div>
			<p>
				Merge its pull requests with <strong>Create a merge commit</strong>. A squash or rebase
				merge drops the Flared history that the next upgrade needs.
			</p>
		</details>
	</section>
{/if}

<div class="divider"></div>

<SectionHeader title="Your data" />
<div id="export" class="anchor">
	<ExportPanel apiBase="/api/v1" retentionDays={data.usage?.retentionDays ?? null} />
</div>

<DeleteAccount
	endpoint="/api/account/delete"
	confirmation={account}
	afterDeletion={owner
		? 'This installation closes for good. To use Flared again, deploy a new copy.'
		: 'Your account and its sign-in end. The workspace stays with its owner.'}
	fresh={data.tokens?.freshUntil != null && Date.parse(data.tokens.freshUntil) > Date.now()}
	blocked={null}
	onReauthRequired={() => void askReauth()}
	onDeleted={() => window.location.assign('/')}
/>

<style>
	.reauth {
		padding: 1.25rem;
		border: var(--rule);
		border-radius: var(--radius-md);
	}
	.password-form,
	.limits-form {
		display: grid;
		gap: 1rem;
		max-width: 24rem;
	}
	.anchor {
		scroll-margin-top: 1.5rem;
	}
	.group {
		display: grid;
	}
	.upgrade-heading {
		margin-top: 0.5rem;
		font-size: 1rem;
	}
	.workflow {
		display: grid;
		gap: 0.75rem;
	}
	.workflow summary {
		color: var(--color-strong);
		font-weight: 600;
		cursor: pointer;
	}
	.workflow ol {
		display: grid;
		gap: 0.4rem;
		padding-left: 1.25rem;
	}
	.workflow code {
		font-family: var(--font-mono);
		font-size: 0.85em;
	}
	.commands {
		display: grid;
		justify-items: start;
		gap: 0.5rem;
		max-width: 38rem;
	}
	.commands pre {
		width: 100%;
		overflow-x: auto;
		padding: 0.75rem 1rem;
		border: var(--rule);
		border-radius: var(--radius-md);
		font-family: var(--font-mono);
		font-size: 0.875rem;
	}
	.link-button {
		padding: 0;
		border: 0;
		background: none;
		color: var(--color-accent-ink);
		font-weight: 600;
		text-decoration: underline;
	}
</style>
