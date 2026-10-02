<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import { scopeDescriptions, type ConsentRequest } from '@flared/contracts/oauth';
	import { consentErrorMessage, decideConsent } from './client';

	interface Props {
		request: ConsentRequest;
		// The signed authorization request from the page's query string.
		oauthQuery: string;
		// The signed-in account, shown so the person knows which workspace they connect.
		account: string;
	}

	let { request, oauthQuery, account }: Props = $props();
	let pending = $state<'approve' | 'deny' | null>(null);
	let error = $state('');

	async function decide(accept: boolean) {
		pending = accept ? 'approve' : 'deny';
		error = '';
		const result = await decideConsent(oauthQuery, accept);
		if (!result.ok) {
			pending = null;
			error = consentErrorMessage(result.code);
			return;
		}
		window.location.assign(result.redirectTo);
	}
</script>

<section class="consent" aria-labelledby="consent-heading">
	<p class="eyebrow">Connect an app</p>
	<h1 id="consent-heading">{request.client.name} wants to use your Flared account</h1>
	<dl class="facts">
		<div>
			<dt>Account</dt>
			<dd>{account}</dd>
		</div>
		{#if request.client.uri}
			<div>
				<dt>App site</dt>
				<dd>{request.client.uri}</dd>
			</div>
		{/if}
		<div>
			<dt>Returns to</dt>
			<dd>{request.redirectHost}</dd>
		</div>
	</dl>
	{#if request.redirectLoopback}
		<p class="warning" role="note">
			This app runs on your computer. Approve only if you started the connection yourself.
		</p>
	{/if}
	<h2>It will be able to</h2>
	<ul>
		{#each request.scopes as scope (scope)}
			<li>{scopeDescriptions[scope]}</li>
		{/each}
		{#if request.offlineAccess}
			<li>Stay connected until you remove it in Settings</li>
		{/if}
	</ul>
	<p class="note">
		It can do this only in your workspace. You can remove it at any time in Settings.
	</p>
	{#if error}<p class="error" role="alert">{error}</p>{/if}
	<div class="actions">
		<button
			type="button"
			class="primary"
			disabled={pending !== null}
			onclick={() => void decide(true)}>{pending === 'approve' ? 'Approving…' : 'Approve'}</button
		>
		<button type="button" disabled={pending !== null} onclick={() => void decide(false)}
			>{pending === 'deny' ? 'Declining…' : 'Deny'}</button
		>
	</div>
</section>

<style>
	.consent {
		display: grid;
		gap: 0.9rem;
	}
	.eyebrow,
	dt,
	.note {
		color: var(--color-muted, #667085);
		font-size: 0.85rem;
	}
	h1 {
		font-size: clamp(1.5rem, 4vw, 1.9rem);
		overflow-wrap: anywhere;
	}
	h2 {
		margin-top: 0.4rem;
		font-size: 0.95rem;
	}
	.facts {
		display: grid;
		gap: 0.4rem;
		margin: 0;
	}
	.facts div {
		display: grid;
		grid-template-columns: 7rem 1fr;
		gap: 0.75rem;
	}
	dd {
		margin: 0;
		color: var(--color-strong, #101828);
		font-size: 0.9rem;
		overflow-wrap: anywhere;
	}
	ul {
		display: grid;
		gap: 0.35rem;
		margin: 0;
		padding-left: 1.2rem;
		color: var(--color-ink, #101828);
		font-size: 0.9rem;
	}
	.warning {
		padding: 0.75rem 0.9rem;
		border: 1px solid var(--color-accent-ink, #b42318);
		border-radius: var(--radius-sm, 6px);
		color: var(--color-strong, #101828);
		font-size: 0.85rem;
	}
	.error {
		color: var(--color-accent-ink, #b42318);
		font-size: 0.85rem;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.6rem;
		margin-top: 0.4rem;
	}
	button {
		min-height: 44px;
		padding: 0.65rem 1.25rem;
		border: 1px solid var(--color-rule, #d0d5dd);
		border-radius: var(--radius-sm, 6px);
		background: var(--color-paper, #fff);
		color: var(--color-ink, #101828);
		font-weight: 620;
	}
	button.primary {
		border-color: var(--color-button-primary, #101828);
		background: var(--color-button-primary, #101828);
		color: var(--color-on-primary, #fff);
	}
	button.primary:hover:not(:disabled) {
		border-color: var(--color-button-primary-hover, #344054);
		background: var(--color-button-primary-hover, #344054);
	}
	button:hover:not(:disabled) {
		border-color: var(--color-muted, #667085);
	}
	button:disabled {
		color: var(--color-muted, #667085);
		background: var(--color-disabled, #eaecf0);
		border-color: var(--color-disabled, #eaecf0);
	}
</style>
