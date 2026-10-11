<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import ConfirmDeletion from '../account/ConfirmDeletion.svelte';
	import { shownWorkspace } from './shown';

	interface Props {
		// The edition's deletion route. It receives { confirmation } as JSON and the shown
		// workspace in a header.
		endpoint: string;
		// The workspace's name, which the owner types to confirm.
		name: string;
		// Whether the last sign-in is recent enough for the request.
		fresh: boolean;
		// Why deletion cannot start now, with a link to fix it; null when it can.
		blocked: { message: string; href: string; action: string } | null;
		onReauthRequired: () => void;
		onDeleted: () => void | Promise<void>;
	}

	let { name, ...rest }: Props = $props();
	const workspace = shownWorkspace();
</script>

<ConfirmDeletion
	id="delete-workspace"
	headers={workspace}
	title="Delete workspace"
	description="Permanently removes {name} and stops its links."
	openLabel="Delete workspace…"
	lead="Deletion stops every short link of {name} at once and removes its links, domains, analytics, API tokens, and connected apps. Your account and your other workspaces stay. It cannot be undone."
	items={[
		'Export the data of this workspace first if you want to keep it.',
		'Its short links stop redirecting within a minute.',
		'Their addresses stay reserved, so no one else can use them.'
	]}
	confirmation={name}
	submitLabel="Delete this workspace permanently"
	keepLabel="Keep the workspace"
	{...rest}
/>
