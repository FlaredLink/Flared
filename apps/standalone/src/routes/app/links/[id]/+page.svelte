<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import { onMount } from 'svelte';
	import type { Action } from 'svelte/action';
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import LinkAnalytics from '@flared/ui/analytics/LinkAnalytics.svelte';
	import LinkEditForm from '@flared/ui/links/LinkEditForm.svelte';
	import LinkHeader from '@flared/ui/links/LinkHeader.svelte';
	import { linkErrorMessage } from '@flared/ui/links/messages';
	import SplitView from '@flared/ui/molecules/SplitView.svelte';
	import SidePanel from '@flared/ui/molecules/SidePanel.svelte';
	import Callout from '@flared/ui/molecules/Callout.svelte';
	import { appRoutes } from '$lib/routes';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
	let pending = $state(false);

	const shortName = $derived(`${data.link.hostname}/${data.link.slug}`);
	const notices = {
		edit: 'Saved.',
		enable: 'Link enabled. The short link opens again.',
		disable: 'Link disabled. The short link no longer opens.'
	} as const;
	const failure = $derived(
		form && 'error' in form && form.error
			? { message: linkErrorMessage(form.error.code, form.error.message), field: form.error.field }
			: null
	);
	const editValues = $derived(form && 'values' in form ? form.values : null);
	// A failed edit sends its values back; a failed disable or enable does not.
	const editError = $derived(failure && editValues ? failure : null);
	const toggleError = $derived(failure && !editValues ? failure.message : null);
	const notice = $derived(form && 'updated' in form && form.updated ? notices[form.updated] : '');

	// The edit panel opens from the Edit button, from #edit, and after a failed save.
	let editing = $state(false);
	$effect.pre(() => {
		if (editError) editing = true;
	});
	onMount(() => {
		const fromHash = () => {
			if (window.location.hash === '#edit' && !data.link.blocked) editing = true;
		};
		fromHash();
		window.addEventListener('hashchange', fromHash);
		return () => window.removeEventListener('hashchange', fromHash);
	});

	function closeEdit() {
		editing = false;
		if (window.location.hash === '#edit')
			history.replaceState(history.state, '', window.location.pathname + window.location.search);
	}

	const enhanceUpdate: Action<HTMLFormElement> = (node) =>
		enhance(node, () => {
			pending = true;
			return async ({ result, update }) => {
				await update({ reset: false });
				pending = false;
				if (result.type === 'success') closeEdit();
			};
		});

	const ranges = $derived(
		[7, 30].map((days) => ({
			label: `${days} days`,
			href: `?days=${days}`,
			current: data.days === days
		}))
	);
</script>

<svelte:head><title>{shortName} · Flared</title></svelte:head>

{#snippet editPanel()}
	<SidePanel id="link-edit-label" label="Edit link" onclose={closeEdit}>
		<LinkEditForm
			action="?/update"
			link={data.link}
			values={editValues}
			error={editError}
			{pending}
			enhance={enhanceUpdate}
			oncancel={closeEdit}
		/>
	</SidePanel>
{/snippet}

<SplitView panel={editing && !data.link.blocked ? editPanel : undefined}>
	<LinkHeader
		link={data.link}
		apiBase="/api/v1"
		crumbs={[
			{ label: data.workspaceName ?? 'Workspace' },
			{ label: 'Links', href: appRoutes.app },
			{ label: data.link.title ?? shortName }
		]}
		backHref={appRoutes.app}
		action="?/update"
		enhance={enhanceUpdate}
		{pending}
		{notice}
		error={toggleError}
		onedit={() => (editing = true)}
	/>

	{#if data.analytics.status === 'ready'}
		<LinkAnalytics
			analytics={data.analytics.analytics}
			{ranges}
			navigate={(href) => goto(href, { noScroll: true, keepFocus: true })}
			iconHref={(hostname) => `/api/v1/icons/${hostname}`}
		/>
	{:else}
		<Callout tone="danger" role="alert" title="We couldn’t load the clicks for this link">
			<p>Refresh the page to try again. The link still redirects.</p>
		</Callout>
	{/if}
</SplitView>
