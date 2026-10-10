<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import SettingRow from '../molecules/SettingRow.svelte';
	import Button from '../atoms/Button.svelte';

	interface Props {
		// The edition's deletion route. It receives { confirmation } as JSON.
		endpoint: string;
		// What the owner types to confirm, such as the account email.
		confirmation: string;
		// Whether the last sign-in is recent enough for the request.
		fresh: boolean;
		// What happens after the deletion, such as signing up again in the cloud.
		afterDeletion: string;
		// Why deletion cannot start now, with a link to fix it; null when it can.
		blocked: { message: string; href: string; action: string } | null;
		onReauthRequired: () => void;
		onDeleted: () => void | Promise<void>;
	}

	let {
		endpoint,
		confirmation,
		fresh,
		afterDeletion,
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
				headers: { 'content-type': 'application/json' },
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

<section class="delete" aria-labelledby="delete-heading">
	<SettingRow
		icon="trash"
		id="delete-heading"
		title="Delete account"
		description="Permanently removes your account and stops your links."
		danger
	>
		{#if blocked}
			<p class="blocked">{blocked.message} <a href={blocked.href}>{blocked.action}</a></p>
		{:else if !open}
			<Button variant="danger" onclick={() => (open = true)}>Delete account…</Button>
		{/if}
	</SettingRow>
	{#if open && !blocked}
		<form
			onsubmit={(event) => {
				event.preventDefault();
				void remove();
			}}
		>
			<p class="lead">
				Deletion stops every short link at once and removes your links, domains, analytics, API
				tokens, and connected apps. It cannot be undone.
			</p>
			<ul>
				<li>Export your data first if you want to keep it.</li>
				<li>Your short links stop redirecting within a minute.</li>
				<li>Their addresses stay reserved, so no one else can use them.</li>
				<li>{afterDeletion}</li>
			</ul>
			<label for="delete-confirmation">Type <strong>{confirmation}</strong> to confirm</label>
			<!-- svelte-ignore a11y_autofocus -->
			<input
				id="delete-confirmation"
				bind:value={typed}
				autocomplete="off"
				autocapitalize="none"
				spellcheck="false"
				autofocus
			/>
			{#if error}<p class="error" role="alert">{error}</p>{/if}
			<div class="actions">
				<Button type="submit" variant="danger" disabled={!matches || pending}
					>{pending ? 'Deleting…' : 'Delete my account permanently'}</Button
				>
				<Button
					variant="ghost"
					disabled={pending}
					onclick={() => {
						open = false;
						typed = '';
						error = '';
					}}>Keep my account</Button
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
