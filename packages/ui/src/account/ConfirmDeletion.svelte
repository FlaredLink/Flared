<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	// The danger row and the typed confirmation of a deletion. DeleteAccount and DeleteWorkspace
	// supply the words.
	import SettingRow from '../molecules/SettingRow.svelte';
	import Button from '../atoms/Button.svelte';

	interface Props {
		// Prefixes the element IDs, so two deletions can share a page.
		id: string;
		// The edition's deletion route. It receives { confirmation } as JSON.
		endpoint: string;
		// Extra request headers, such as the workspace the page shows.
		headers?: () => Record<string, string>;
		title: string;
		description: string;
		openLabel: string;
		lead: string;
		items: string[];
		// What the person types to confirm, such as the account email.
		confirmation: string;
		submitLabel: string;
		keepLabel: string;
		// Whether the last sign-in is recent enough for the request.
		fresh: boolean;
		// Why deletion cannot start now, with a link to fix it; null when it can.
		blocked: { message: string; href: string; action: string } | null;
		onReauthRequired: () => void;
		onDeleted: () => void | Promise<void>;
	}

	let {
		id,
		endpoint,
		headers = () => ({}),
		title,
		description,
		openLabel,
		lead,
		items,
		confirmation,
		submitLabel,
		keepLabel,
		fresh,
		blocked,
		onReauthRequired,
		onDeleted
	}: Props = $props();

	let open = $state(false);
	let typed = $state('');
	let pending = $state(false);
	let error = $state('');
	const matches = $derived(typed.trim().toLowerCase() === confirmation.toLowerCase());

	async function remove() {
		if (!fresh) return onReauthRequired();
		pending = true;
		error = '';
		try {
			const response = await fetch(endpoint, {
				method: 'POST',
				headers: { 'content-type': 'application/json', ...headers() },
				body: JSON.stringify({ confirmation: typed.trim() })
			});
			if (response.status === 202) return await onDeleted();
			const body: unknown = await response.json().catch(() => null);
			const failure =
				typeof body === 'object' && body !== null && 'error' in body
					? (body.error as { code?: unknown; message?: unknown })
					: null;
			if (failure?.code === 'REAUTH_REQUIRED') return onReauthRequired();
			error =
				typeof failure?.message === 'string'
					? failure.message
					: 'We could not start the deletion. Try again.';
		} catch {
			error = 'We could not reach Flared. Check your connection and try again.';
		} finally {
			pending = false;
		}
	}
</script>

<section class="delete" aria-labelledby="{id}-heading">
	<SettingRow icon="trash" id="{id}-heading" {title} {description} danger>
		{#if blocked}
			<p class="blocked">{blocked.message} <a href={blocked.href}>{blocked.action}</a></p>
		{:else if !open}
			<Button variant="danger" onclick={() => (open = true)}>{openLabel}</Button>
		{/if}
	</SettingRow>
	{#if open && !blocked}
		<form
			onsubmit={(event) => {
				event.preventDefault();
				void remove();
			}}
		>
			<p class="lead">{lead}</p>
			<ul>
				{#each items as item (item)}<li>{item}</li>{/each}
			</ul>
			<label for="{id}-confirmation">Type <strong>{confirmation}</strong> to confirm</label>
			<!-- svelte-ignore a11y_autofocus -->
			<input
				id="{id}-confirmation"
				bind:value={typed}
				autocomplete="off"
				autocapitalize="none"
				spellcheck="false"
				autofocus
			/>
			{#if error}<p class="error" role="alert">{error}</p>{/if}
			<div class="actions">
				<Button type="submit" variant="danger" disabled={!matches || pending}
					>{pending ? 'Deleting…' : submitLabel}</Button
				>
				<Button
					variant="ghost"
					disabled={pending}
					onclick={() => {
						open = false;
						typed = '';
						error = '';
					}}>{keepLabel}</Button
				>
			</div>
		</form>
	{/if}
</section>

<style>
	.blocked {
		max-width: 30rem;
		color: var(--color-ink);
		font-size: 0.9375rem;
		text-align: right;
	}
	.blocked a {
		color: var(--color-link);
		text-decoration: underline;
		text-underline-offset: 3px;
	}
	form {
		display: grid;
		gap: 0.6rem;
		max-width: 34rem;
		margin: 1rem 0 0 3.25rem;
		padding: 1rem 1.25rem 1.25rem;
		border: 1px solid color-mix(in oklch, var(--color-danger) 30%, transparent);
		border-radius: var(--radius-md, 0.625rem);
		background: var(--color-danger-soft);
	}
	.lead {
		color: var(--color-strong);
		font-size: 0.9375rem;
	}
	ul {
		display: grid;
		gap: 0.2rem;
		margin: 0;
		padding-left: 1.2rem;
	}
	li {
		color: var(--color-ink);
		font-size: 0.875rem;
	}
	label {
		margin-top: 0.4rem;
		color: var(--color-strong);
		font-size: 0.9375rem;
	}
	input {
		min-height: 2.75rem;
		padding: 0 0.9rem;
		border: 1px solid var(--color-rule);
		border-radius: var(--radius-control, 0.5rem);
		background: var(--color-input);
		color: var(--color-strong);
		font: inherit;
	}
	input:focus {
		border-color: var(--color-strong);
		outline: 1px solid var(--color-strong);
		outline-offset: -1px;
	}
	.error {
		color: var(--color-danger);
		font-size: 0.875rem;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin-top: 0.25rem;
	}
	@media (max-width: 52rem) {
		.blocked {
			text-align: left;
		}
		form {
			margin-left: 0;
		}
	}
</style>
