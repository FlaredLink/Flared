<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import {
		isWorkspace,
		normalizeWorkspaceName,
		workspaceNameMaxLength
	} from '@flared/contracts/workspace';
	import Panel from '../layout/Panel.svelte';

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

<Panel id="workspace-heading" title="Workspace" icon="buildings" tone="teal">
	<form onsubmit={save}>
		<label for="workspace-name">Workspace name</label>
		<div class="row">
			<input
				id="workspace-name"
				bind:value
				maxlength={workspaceNameMaxLength * 2}
				autocomplete="off"
				aria-invalid={error ? 'true' : undefined}
				aria-describedby="workspace-help"
			/>
			<button type="submit" disabled={pending || unchanged}>{pending ? 'Saving…' : 'Save'}</button>
		</div>
		<p id="workspace-help" class="lead">The sidebar shows this name. Only you see it.</p>
	</form>
	<p class="status" role="status" aria-live="polite">{status}</p>
	{#if error}<p class="error" role="alert">{error}</p>{/if}
</Panel>

<style>
	form {
		display: grid;
		gap: 0.4rem;
	}
	label {
		color: var(--color-strong, #101828);
		font-size: 0.875rem;
		font-weight: 600;
	}
	.row {
		display: flex;
		gap: 0.5rem;
	}
	input {
		flex: 1;
		min-width: 0;
		min-height: 44px;
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--color-rule, #d0d5dd);
		border-radius: var(--radius-sm, 6px);
		background: var(--color-input, #fff);
		color: var(--color-ink, #101828);
		font: inherit;
	}
	input[aria-invalid='true'] {
		border-color: var(--color-danger, #b42318);
	}
	.lead,
	.status {
		color: var(--color-muted, #667085);
		font-size: 0.85rem;
	}
	.status:empty {
		display: none;
	}
	.error {
		color: var(--color-danger, #b42318);
		font-size: 0.85rem;
	}
	button {
		min-height: 44px;
		padding: 0.65rem 1.15rem;
		border: 1px solid var(--color-button-primary, #101828);
		border-radius: var(--radius-sm, 6px);
		background: var(--color-button-primary, #101828);
		color: var(--color-on-primary, #fff);
		font-weight: 620;
	}
	button:hover:not(:disabled) {
		background: var(--color-button-primary-hover, #344054);
		border-color: var(--color-button-primary-hover, #344054);
	}
	button:disabled {
		border-color: var(--color-disabled, #f2f4f7);
		background: var(--color-disabled, #f2f4f7);
		color: var(--color-muted, #667085);
	}
</style>
