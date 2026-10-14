<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import DeleteAccount from '@flared/ui/account/DeleteAccount.svelte';
	import SettingRow from '@flared/ui/molecules/SettingRow.svelte';
	import { useSettings } from '$lib/settings';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const settings = useSettings();
	const account = $derived(
		data.auth.status === 'authenticated' ? data.auth.principal.user.name : ''
	);
	const owner = $derived(data.workspace?.role === 'owner');
</script>

{#if account}
	<SettingRow icon="user" title="Username" description="Used to sign in.">
		<p class="value">{account}</p>
	</SettingRow>
{/if}
<DeleteAccount
	endpoint="/api/account/delete"
	confirmation={account}
	afterDeletion={owner
		? 'This installation closes for good. To use Flared again, deploy a new copy.'
		: 'Your account and its sign-in end. The workspace stays with its owner.'}
	fresh={settings.fresh()}
	blocked={null}
	onReauthRequired={settings.askReauth}
	onDeleted={() => window.location.assign('/')}
/>

<style>
	.value {
		flex: 1;
		overflow-wrap: anywhere;
		color: var(--color-strong);
		font-size: 1rem;
	}
</style>
