<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	interface Props {
		// The edition's deletion route. It receives { confirmation } as JSON.
		endpoint: string;
		// What the owner types to confirm, such as the account email.
		confirmation: string;
		// Whether the last sign-in is recent enough for the request.
		fresh: boolean;
		// Why deletion cannot start now, with a link to fix it; null when it can.
		blocked: { message: string; href: string; action: string } | null;
		onReauthRequired: () => void;
		onDeleted: () => void | Promise<void>;
	}

	let { endpoint, confirmation, fresh, blocked, onReauthRequired, onDeleted }: Props = $props();

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
	<h2 id="delete-heading">Delete your account</h2>
	<p class="lead">
		Deleting your account stops every short link at once and removes your links, domains, analytics,
		API tokens, and connected apps. It cannot be undone. Export your data first if you want to keep
		it.
	</p>
	{#if blocked}
		<p class="blocked">{blocked.message} <a href={blocked.href}>{blocked.action}</a></p>
	{:else if !open}
		<button type="button" class="danger" onclick={() => (open = true)}>Delete account…</button>
	{:else}
		<form
			onsubmit={(event) => {
				event.preventDefault();
				void remove();
			}}
		>
			<ul>
				<li>Your short links stop redirecting within a minute.</li>
				<li>Their addresses stay reserved, so no one else can use them.</li>
				<li>You can sign up again later with the same email, into a new, empty account.</li>
			</ul>
			<label for="delete-confirmation">Type <strong>{confirmation}</strong> to confirm</label>
			<input
				id="delete-confirmation"
				bind:value={typed}
				autocomplete="off"
				autocapitalize="none"
				spellcheck="false"
			/>
			{#if error}<p class="error" role="alert">{error}</p>{/if}
			<div class="actions">
				<button type="submit" class="danger" disabled={!matches || pending}
					>{pending ? 'Deleting…' : 'Delete my account permanently'}</button
				>
				<button
					type="button"
					class="quiet"
					disabled={pending}
					onclick={() => {
						open = false;
						typed = '';
						error = '';
					}}>Keep my account</button
				>
			</div>
		</form>
	{/if}
</section>

<style>
	.delete {
		display: grid;
		gap: 0.75rem;
		max-width: 44rem;
	}
	h2 {
		font-size: 1.05rem;
	}
	.lead,
	li {
		color: var(--color-muted, #667085);
		font-size: 0.85rem;
	}
	.blocked {
		color: var(--color-ink, #101828);
		font-size: 0.9rem;
	}
	.blocked a {
		color: var(--color-strong, #101828);
		font-weight: 600;
		text-decoration: underline;
	}
	form {
		display: grid;
		gap: 0.6rem;
		max-width: 28rem;
	}
	ul {
		display: grid;
		gap: 0.3rem;
		margin: 0;
		padding-left: 1.1rem;
	}
	label {
		color: var(--color-strong, #101828);
		font-size: 0.85rem;
		font-weight: 650;
		overflow-wrap: anywhere;
	}
	input {
		width: 100%;
		min-width: 0;
		min-height: 44px;
		padding: 0.6rem 0.8rem;
		color: var(--color-ink, #101828);
		border: 1px solid var(--color-rule, #d0d5dd);
		border-radius: var(--radius-sm, 6px);
		background: var(--color-paper, #fff);
	}
	input:focus-visible {
		border-color: var(--color-muted, #667085);
		outline: 1px solid var(--color-muted, #667085);
		outline-offset: -1px;
	}
	.error {
		color: var(--color-accent-ink, #b42318);
		font-size: 0.85rem;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}
	button {
		justify-self: start;
		min-height: 44px;
		padding: 0.65rem 1.15rem;
		border-radius: var(--radius-sm, 6px);
		font-weight: 620;
	}
	button.danger {
		border: 1px solid var(--color-accent-ink, #b42318);
		background: var(--color-accent-ink, #b42318);
		color: var(--color-on-primary, #fff);
	}
	button:disabled {
		color: var(--color-muted, #667085);
		background: var(--color-disabled, #eaecf0);
		border-color: var(--color-disabled, #eaecf0);
	}
	button.quiet {
		border: 1px solid var(--color-rule, #d0d5dd);
		background: var(--color-paper, #fff);
		color: var(--color-ink, #101828);
	}
</style>
