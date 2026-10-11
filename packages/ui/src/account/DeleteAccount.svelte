<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import ConfirmDeletion from './ConfirmDeletion.svelte';

	interface Props {
		// The edition's deletion route. It receives { confirmation } as JSON.
		endpoint: string;
		// What the owner types to confirm, such as the account email.
		confirmation: string;
		// The names of the workspaces the person owns; the deletion removes each of them.
		workspaces?: string[];
		// Whether the last sign-in is recent enough for the request.
		fresh: boolean;
		// What happens after the deletion, such as signing up again in the cloud.
		afterDeletion: string;
		// Why deletion cannot start now, with a link to fix it; null when it can.
		blocked: { message: string; href: string; action: string } | null;
		onReauthRequired: () => void;
		onDeleted: () => void | Promise<void>;
	}

	let { workspaces = [], afterDeletion, ...rest }: Props = $props();
	const lead = $derived(
		workspaces.length > 1
			? `Deletion removes your account and the workspaces you own: ${workspaces.join(', ')}. It stops every short link of these workspaces at once and removes their links, domains, analytics, API tokens, and connected apps. It cannot be undone.`
			: 'Deletion stops every short link at once and removes your links, domains, analytics, API tokens, and connected apps. It cannot be undone.'
	);
</script>

<ConfirmDeletion
	id="delete-account"
	title="Delete account"
	description="Permanently removes your account and stops your links."
	openLabel="Delete account…"
	{lead}
	items={[
		'Export your data first if you want to keep it.',
		'Your short links stop redirecting within a minute.',
		'Their addresses stay reserved, so no one else can use them.',
		afterDeletion
	]}
	submitLabel="Delete my account permanently"
	keepLabel="Keep my account"
	{...rest}
/>
