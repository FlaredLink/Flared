<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import { scopeDescriptions, type ConsentRequest } from '@flared/contracts/oauth';
	import { consentErrorMessage, decideConsent } from './client';
	import Glyph from '../icons/Glyph.svelte';
	import Button from '../atoms/Button.svelte';
	import Callout from '../molecules/Callout.svelte';

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
		<Callout tone="warning">
			<p>This app runs on your computer. Approve only if you started the connection yourself.</p>
		</Callout>
	{/if}
	<h2>It will be able to</h2>
	<ul>
		{#each request.scopes as scope (scope)}
			<li><Glyph name="check" size={18} />{scopeDescriptions[scope]}</li>
		{/each}
		{#if request.offlineAccess}
			<li><Glyph name="check" size={18} />Stay connected until you remove it</li>
		{/if}
	</ul>
	<p class="note">
		<Glyph name="lock" size={18} />It can do this only in your workspace. You can disconnect it at
		any time.
	</p>
	{#if error}<p class="error" role="alert">{error}</p>{/if}
	<div class="actions">
		<Button
			variant="primary"
			size="lg"
			disabled={pending !== null}
			onclick={() => void decide(true)}>{pending === 'approve' ? 'Approving…' : 'Approve'}</Button
		>
		<Button size="lg" disabled={pending !== null} onclick={() => void decide(false)}
			>{pending === 'deny' ? 'Declining…' : 'Deny'}</Button
		>
	</div>
</section>

<style>
	.consent {
		display: grid;
		gap: 1rem;
	}
	.eyebrow {
		color: var(--color-lead);
		font-size: 0.8125rem;
		font-weight: 600;
		letter-spacing: 0.12em;
		text-transform: uppercase;
	}
	h1 {
		color: var(--color-strong);
		font-size: clamp(1.6rem, 4vw, 2.1rem);
		font-weight: 800;
		letter-spacing: -0.04em;
		line-height: 1.1;
		overflow-wrap: anywhere;
	}
	h2 {
		margin-top: 0.5rem;
		color: var(--color-strong);
		font-size: 1rem;
		font-weight: 600;
	}
	.facts {
		display: grid;
		margin: 0;
		border-top: 1px solid var(--color-rule);
	}
	.facts div {
		display: grid;
		grid-template-columns: 7rem minmax(0, 1fr);
		gap: 0.75rem;
		padding: 0.7rem 0;
		border-bottom: 1px solid var(--color-rule);
	}
	dt {
		color: var(--color-lead);
		font-size: 0.9375rem;
	}
	dd {
		margin: 0;
		color: var(--color-strong);
		font-size: 0.9375rem;
		overflow-wrap: anywhere;
	}
	ul {
		display: grid;
		gap: 0.55rem;
		margin: 0;
		padding: 0;
		list-style: none;
		color: var(--color-ink);
		font-size: 0.9375rem;
	}
	li {
		display: flex;
		align-items: flex-start;
		gap: 0.6rem;
	}
	li :global(svg) {
		margin-top: 0.15rem;
		color: var(--color-positive);
	}
	.note {
		display: flex;
		align-items: flex-start;
		gap: 0.6rem;
		color: var(--color-lead);
		font-size: 0.875rem;
	}
	.note :global(svg) {
		margin-top: 0.1rem;
	}
	.error {
		color: var(--color-danger);
		font-size: 0.9375rem;
	}
	.actions {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.75rem;
		margin-top: 0.5rem;
	}
</style>
