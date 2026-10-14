<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import Callout from '@flared/ui/molecules/Callout.svelte';
	import CopyButton from '@flared/ui/molecules/CopyButton.svelte';
	import Checkbox from '@flared/ui/atoms/Checkbox.svelte';
	import { postJson } from '$lib/auth-client';
	import { defaultSourceUrl } from '$lib/source';
	import { availableRelease, parseRepository, workflowLinks, workflowPath } from '$lib/updates';
	import upgradeWorkflow from '../../../../../../../deploy/flared-upgrade.yml?raw';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// Update checks: only the owner sees and changes them.
	const times = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
	const release = $derived(availableRelease(data.updates, __FLARED_VERSION__));
	const upgradeCommands = $derived(
		release ? `git fetch upstream --tags\ngit merge v${release.version}\ngit push` : ''
	);
	// An operator who publishes their copy as SOURCE_URL needs not type it.
	let repository = $state(
		page.data.sourceUrl === defaultSourceUrl ? '' : (parseRepository(page.data.sourceUrl) ?? '')
	);
	const links = $derived.by(() => {
		const name = parseRepository(repository);
		return name ? workflowLinks(name, upgradeWorkflow) : null;
	});
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
</script>

{#if data.updates}
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
			<!-- A details element does not lay out its content as a grid, so this wrapper spaces it. -->
			<div class="workflow-body">
				<p>
					The workflow checks for a new release each day. It opens a pull request that merges the
					release into your repository, or an issue when you must act. Deploy on Cloudflare leaves
					workflows out of your copy, so set it up once:
				</p>
				<div class="field">
					<label for="repository">Your repository on GitHub</label>
					<input
						id="repository"
						bind:value={repository}
						placeholder="owner/flared"
						autocomplete="off"
						autocapitalize="none"
						spellcheck="false"
					/>
					<small>The owner and name of your copy, such as <code>owner/flared</code>.</small>
				</div>
				<ol>
					<li>
						{#if links}
							<a href={links.file} target="_blank" rel="noopener">Add the workflow file on GitHub</a
							>. GitHub opens <code>{workflowPath}</code> with its content filled in; select
							<strong>Commit changes</strong>.
						{:else}
							Add the workflow file to your repository as <code>{workflowPath}</code>.
						{/if}
					</li>
					<li>
						{#if links}
							Open the <a href={links.actions} target="_blank" rel="noopener">Actions settings</a>.
						{:else}
							In the repository settings, open <strong>Actions → General</strong>.
						{/if}
						Under <strong>Workflow permissions</strong>, select
						<strong>Allow GitHub Actions to create and approve pull requests</strong>, then
						<strong>Save</strong>.
					</li>
					<li>
						Optional: add the repository variable <code>FLARED_AUTO_UPGRADE</code> with the value
						<code>true</code>{#if links}
							on the <a href={links.variable} target="_blank" rel="noopener">new variable page</a
							>{/if}. The workflow then merges each upgrade that merges cleanly and is not marked
						breaking, and Workers Builds deploys it.
					</li>
				</ol>
				<details class="file">
					<summary>Show the workflow file</summary>
					<div class="commands">
						<pre><code>{upgradeWorkflow}</code></pre>
						<CopyButton text={upgradeWorkflow} label="Copy the workflow" kind="button" size="sm" />
					</div>
				</details>
				<p>
					Merge its pull requests with <strong>Create a merge commit</strong>. A squash or rebase
					merge drops the Flared history that the next upgrade needs.
				</p>
			</div>
		</details>
	</section>
{:else}
	<section class="notice" role="alert">
		<h2>We couldn’t load the update checks</h2>
		<p>Refresh the page to try again.</p>
	</section>
{/if}

<style>
	.upgrade-heading {
		margin-top: 0.5rem;
		font-size: 1rem;
	}
	.workflow-body {
		display: grid;
		gap: 0.75rem;
		margin-top: 0.75rem;
	}
	.workflow .file summary {
		font-weight: 500;
	}
	.workflow .file .commands {
		margin-top: 0.5rem;
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
</style>
