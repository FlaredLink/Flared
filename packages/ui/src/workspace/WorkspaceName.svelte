<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import {
		isWorkspace,
		normalizeWorkspaceName,
		workspaceNameMaxLength
	} from '@flared/contracts/workspace';
	import SettingRow from '../molecules/SettingRow.svelte';
	import Button from '../atoms/Button.svelte';

	interface Props {
		// The path of the /v1 API for this browser, such as "/api/v1".
		apiBase: string;
		name: string;
		// Runs after a rename, so the page can reload the name it shows elsewhere.
		onRenamed: () => void | Promise<void>;
	}

	let { apiBase, name, onRenamed }: Props = $props();

	// The field starts from the saved name and keeps what the person types.
	// svelte-ignore state_referenced_locally
	let value = $state(name);
	let pending = $state(false);
	let status = $state('');
	let error = $state('');
	const unchanged = $derived(normalizeWorkspaceName(value) === name);

	async function save(event: SubmitEvent) {
		event.preventDefault();
		const next = normalizeWorkspaceName(value);
		if (next === null) {
			error = `Use a name of 1 to ${workspaceNameMaxLength} characters.`;
			return;
		}
		pending = true;
		status = '';
		error = '';
		try {
			const response = await fetch(`${apiBase}/workspace`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ name: next })
			});
			const body: unknown = await response.json().catch(() => null);
			const workspace =
				typeof body === 'object' && body !== null ? Reflect.get(body, 'workspace') : null;
			if (!response.ok || !isWorkspace(workspace)) {
				error = 'We could not rename the workspace. Try again.';
				return;
			}
			value = workspace.name;
			status = 'Workspace renamed.';
			await onRenamed();
		} catch {
			error = 'We could not rename the workspace. Try again.';
		} finally {
			pending = false;
		}
	}
</script>

<SettingRow
	icon="user"
	id="workspace-name-heading"
	title="Workspace name"
	description="Shown in your sidebar. Only you see it."
>
	<form onsubmit={save} aria-labelledby="workspace-name-heading">
		<div class="row">
			<label class="visually-hidden" for="workspace-name">Workspace name</label>
			<input
				id="workspace-name"
				bind:value
				maxlength={workspaceNameMaxLength * 2}
				autocomplete="off"
				aria-invalid={error ? 'true' : undefined}
				aria-describedby={error ? 'workspace-error' : undefined}
			/>
			<Button
				type="submit"
				variant={unchanged ? 'secondary' : 'primary'}
				disabled={pending || unchanged}>{pending ? 'Saving…' : 'Save'}</Button
			>
		</div>
		<p class="status" role="status" aria-live="polite">{status}</p>
		{#if error}<p id="workspace-error" class="error" role="alert">{error}</p>{/if}
	</form>
</SettingRow>

<style>
	form {
		display: grid;
		flex: 1;
		gap: 0.4rem;
		max-width: 38rem;
	}
	.row {
		display: flex;
		gap: 0.75rem;
	}
	input {
		flex: 1;
		min-width: 0;
		min-height: 2.75rem;
		padding: 0 0.9rem;
		border: 1px solid var(--color-rule);
		border-radius: var(--radius-control, 0.5rem);
		background: var(--color-input);
		color: var(--color-strong);
		font: inherit;
		font-size: 0.9375rem;
	}
	input:focus {
		border-color: var(--color-strong);
		outline: 1px solid var(--color-strong);
		outline-offset: -1px;
	}
	input[aria-invalid='true'] {
		border-color: var(--color-danger);
	}
	.status {
		color: var(--color-lead);
		font-size: 0.875rem;
	}
	.status:empty {
		display: none;
	}
	.error {
		color: var(--color-danger);
		font-size: 0.875rem;
	}
	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
</style>
