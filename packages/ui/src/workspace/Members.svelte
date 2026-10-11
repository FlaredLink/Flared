<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import { maxEmailLength, normalizeEmail, type MemberPage } from '@flared/contracts/members';
	import { cancelInvite, sendInvite } from './client';
	import { shownWorkspace } from './shown';
	import Glyph from '../icons/Glyph.svelte';
	import Badge from '../atoms/Badge.svelte';
	import Button from '../atoms/Button.svelte';
	import TextInput from '../atoms/TextInput.svelte';
	import SectionHeader from '../molecules/SectionHeader.svelte';

	interface Props {
		page: MemberPage;
		// The path of the /v1 API for this browser, such as "/api/v1".
		apiBase: string;
		// Called after a change succeeds, so the app reloads the list.
		onChanged: () => void | Promise<void>;
		workspaceName: string;
		// Only the owner invites; a member sees the list.
		owner: boolean;
	}

	let { page, apiBase, onChanged, workspaceName, owner }: Props = $props();
	const workspace = shownWorkspace();
	const dates = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

	let email = $state('');
	// "invite", "resend:<id>", or "cancel:<id>" while a request runs.
	let pending = $state<string | null>(null);
	let status = $state('');
	let error = $state('');
	let confirmingId = $state<string | null>(null);
	const full = $derived(page.used >= page.limit);

	async function invite(event: SubmitEvent) {
		event.preventDefault();
		const address = normalizeEmail(email);
		if (address === null) {
			error = 'Enter an email address.';
			return;
		}
		pending = 'invite';
		status = '';
		error = '';
		const result = await sendInvite(apiBase, { email: address }, workspace());
		pending = null;
		if (!result.ok) {
			error = result.message;
			return;
		}
		email = '';
		status = result.emailSent
			? `Invite sent to ${address}.`
			: `We saved the invite, but the email to ${address} failed. Send it again from the list.`;
		await onChanged();
	}

	async function resend(id: string, address: string) {
		pending = `resend:${id}`;
		status = '';
		error = '';
		const result = await sendInvite(apiBase, { id }, workspace());
		pending = null;
		if (!result.ok) {
			error = result.message;
			return;
		}
		status = result.emailSent
			? `Invite sent again to ${address}. The earlier link no longer works.`
			: `The email to ${address} failed. Try again.`;
		await onChanged();
	}

	async function cancel(id: string, address: string) {
		pending = `cancel:${id}`;
		status = '';
		error = '';
		const done = await cancelInvite(apiBase, id, workspace());
		pending = null;
		confirmingId = null;
		if (!done) {
			error = 'We could not cancel the invite. Try again.';
			return;
		}
		status = `Cancelled the invite to ${address}.`;
		await onChanged();
	}
</script>

<section class="members" aria-labelledby="members-heading">
	<SectionHeader
		id="members-heading"
		title="Members"
		lead={owner
			? `People in ${workspaceName}. Members create and edit links and see analytics. Only you manage domains, billing, and members.`
			: `People in ${workspaceName}. Only the workspace owner can invite or remove members.`}
	/>
	<p class="count">
		{page.used} of {page.limit} places used{page.invites.length > 0
			? ', open invites included'
			: ''}.
	</p>

	{#if owner}
		<form class="invite" onsubmit={invite} aria-labelledby="invite-heading">
			<h3 id="invite-heading">Invite a member</h3>
			<div class="row">
				<label class="visually-hidden" for="invite-email">Email address</label>
				<TextInput
					id="invite-email"
					type="email"
					icon="envelope"
					bind:value={email}
					maxlength={maxEmailLength}
					placeholder="name@example.com"
					autocomplete="off"
					invalid={error !== '' && pending === null && email !== ''}
					disabled={full}
				/>
				<Button type="submit" variant="primary" disabled={pending !== null || full}
					>{pending === 'invite' ? 'Sending…' : 'Send invite'}</Button
				>
			</div>
			<p class="hint">
				{full
					? 'All places are used. Cancel an invite to free a place, or choose a plan with more members.'
					: 'They get an email with a link that works once, for 7 days, for that address only.'}
			</p>
		</form>
	{/if}
	<p class="status" role="status" aria-live="polite">{status}</p>
	{#if error}<p class="error" role="alert">{error}</p>{/if}

	<ul class="list" aria-label="Members">
		{#each page.members as member (member.userId)}
			<li class="row-item">
				<Glyph name={member.role === 'owner' ? 'crown' : 'user'} size={22} />
				<span class="who">
					<span class="email">{member.email}</span>
					<span class="meta">Joined {dates.format(new Date(member.joinedAt))}</span>
				</span>
				<span class="badges">
					{#if member.you}<Badge outlined>You</Badge>{/if}
					<Badge tone={member.role === 'owner' ? 'accent' : 'neutral'}
						>{member.role === 'owner' ? 'Owner' : 'Member'}</Badge
					>
				</span>
			</li>
		{/each}
	</ul>

	{#if owner && page.invites.length > 0}
		<h3 class="small-heading" id="invites-heading">Open invites</h3>
		<ul class="list" aria-labelledby="invites-heading">
			{#each page.invites as item (item.id)}
				<li class="row-item">
					<Glyph name="envelope" size={22} />
					<span class="who">
						<span class="email">{item.email}</span>
						<span class="meta"
							>Link works until <time datetime={item.expiresAt}
								>{dates.format(new Date(item.expiresAt))}</time
							></span
						>
					</span>
					<span class="actions">
						{#if confirmingId === item.id}
							<span class="confirm">Cancel this invite?</span>
							<Button
								size="sm"
								variant="danger"
								disabled={pending !== null}
								onclick={() => void cancel(item.id, item.email)}
								>{pending === `cancel:${item.id}` ? 'Cancelling…' : 'Cancel invite'}</Button
							>
							<Button size="sm" variant="ghost" onclick={() => (confirmingId = null)}>Keep</Button>
						{:else}
							<Button
								size="sm"
								disabled={pending !== null}
								aria-label={`Send the invite to ${item.email} again`}
								onclick={() => void resend(item.id, item.email)}
								>{pending === `resend:${item.id}` ? 'Sending…' : 'Send again'}</Button
							>
							<Button
								size="sm"
								variant="danger-soft"
								disabled={pending !== null}
								aria-label={`Cancel the invite to ${item.email}`}
								onclick={() => (confirmingId = item.id)}>Cancel…</Button
							>
						{/if}
					</span>
				</li>
			{/each}
		</ul>
	{/if}
</section>

<style>
	.members {
		display: grid;
		gap: 1rem;
		min-width: 0;
	}
	.count {
		color: var(--color-strong);
		font-size: 0.9875rem;
	}
	.invite {
		display: grid;
		gap: 0.5rem;
		max-width: 38rem;
	}
	.invite h3,
	.small-heading {
		color: var(--color-strong);
		font-size: 1.0625rem;
		font-weight: 650;
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
	}
	.row :global(.text-input) {
		flex: 1 1 16rem;
	}
	.hint,
	.meta,
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
	.list {
		margin: 0;
		padding: 0;
		border: 1px solid var(--color-rule);
		border-radius: var(--radius-md, 0.625rem);
		background: var(--color-paper);
		list-style: none;
	}
	.row-item {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.6rem 0.85rem;
		padding: 0.85rem 1.1rem;
		color: var(--color-ink);
	}
	.row-item + .row-item {
		border-top: 1px solid var(--color-rule);
	}
	.who {
		display: grid;
		flex: 1 1 12rem;
		gap: 0.1rem;
		min-width: 0;
	}
	.email {
		overflow: hidden;
		color: var(--color-strong);
		font-weight: 600;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.badges,
	.actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.4rem;
	}
	.confirm {
		color: var(--color-strong);
		font-size: 0.9375rem;
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
