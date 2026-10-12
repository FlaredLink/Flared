<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import { maxEmailLength, normalizeEmail, type MemberPage } from '@flared/contracts/members';
	import {
		acceptTransfer,
		cancelInvite,
		cancelTransfer,
		createPasswordReset,
		offerTransfer,
		removeMember,
		sendInvite
	} from './client';
	import { shownWorkspace } from './shown';
	import Glyph from '../icons/Glyph.svelte';
	import Badge from '../atoms/Badge.svelte';
	import Button from '../atoms/Button.svelte';
	import TextInput from '../atoms/TextInput.svelte';
	import SectionHeader from '../molecules/SectionHeader.svelte';
	import Callout from '../molecules/Callout.svelte';
	import CopyField from '../molecules/CopyField.svelte';

	interface Props {
		page: MemberPage;
		// The path of the /v1 API for this browser, such as "/api/v1".
		apiBase: string;
		// Called after a change succeeds, so the app reloads the list.
		onChanged: () => void | Promise<void>;
		workspaceName: string;
		// Only the owner invites and removes; a member sees the list and can leave.
		owner: boolean;
		// Called after the person leaves, so the app opens another workspace.
		onLeft: () => void | Promise<void>;
		// Called when the owner must sign in again before offering the workspace.
		onReauthRequired: () => void;
		// What a change of owner means for billing, for the edition that bills; shown with the
		// offer to both people.
		billingNote?: string;
		// How invites reach people: an email to one address, or a link the owner shares. With
		// links, the owner also gives members links that set a new password.
		delivery?: 'email' | 'link';
	}

	let {
		page,
		apiBase,
		onChanged,
		workspaceName,
		owner,
		onLeft,
		onReauthRequired,
		billingNote,
		delivery = 'email'
	}: Props = $props();
	const workspace = shownWorkspace();
	const dates = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
	const times = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
	// A link the server returned once, shown until the owner closes it.
	let shownLink = $state<{ title: string; url: string; note: string } | null>(null);

	let email = $state('');
	// "invite", "resend:<id>", "cancel:<id>", "remove:<userId>", "leave", "offer:<userId>",
	// "reset:<userId>", "withdraw", or "accept" while a request runs.
	let pending = $state<string | null>(null);
	let status = $state('');
	let error = $state('');
	let confirmingId = $state<string | null>(null);
	const full = $derived(page.used >= page.limit);
	const offeredToYou = $derived(
		page.transfer !== null &&
			page.members.some((member) => member.you && member.userId === page.transfer?.userId)
	);

	async function invite(event: SubmitEvent) {
		event.preventDefault();
		if (delivery === 'link') return createLink();
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

	async function createLink() {
		pending = 'invite';
		status = '';
		error = '';
		shownLink = null;
		const result = await sendInvite(apiBase, 'link', workspace());
		pending = null;
		if (!result.ok || result.url === null) {
			error = result.ok ? 'We could not create the invite link. Try again.' : result.message;
			return;
		}
		const until = result.expiresAt ? ` until ${dates.format(new Date(result.expiresAt))}` : '';
		shownLink = {
			title: 'Invite link',
			url: result.url,
			note: `Send this link to the person you invite. It works once${until}, and the person who opens it creates an account in ${workspaceName}. We show it only now; if it is lost, cancel the invite and create another.`
		};
		await onChanged();
	}

	async function resetLink(userId: string, name: string) {
		pending = `reset:${userId}`;
		status = '';
		error = '';
		shownLink = null;
		const result = await createPasswordReset(apiBase, userId, workspace());
		pending = null;
		if (!result.ok) {
			if (result.reauth) onReauthRequired();
			else error = result.message;
			return;
		}
		shownLink = {
			title: `Password reset link for ${name}`,
			url: result.link.url,
			note: `Send this link to ${name} only. It works once, until ${times.format(new Date(result.link.expiresAt))}. The new password signs them out everywhere; their API tokens keep working. A new link replaces this one.`
		};
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

	// The owner removes a member: "remove:<userId>". A member leaves: "leave".
	async function remove(userId: string | null, address: string) {
		pending = userId === null ? 'leave' : `remove:${userId}`;
		status = '';
		error = '';
		const result = await removeMember(apiBase, userId === null ? 'self' : { userId }, workspace());
		pending = null;
		confirmingId = null;
		if (!result.ok) {
			error = result.message;
			return;
		}
		if (userId === null) return onLeft();
		status = `Removed ${address}. Their tokens and connected apps for ${workspaceName} stopped working.`;
		await onChanged();
	}

	async function offer(userId: string, address: string) {
		pending = `offer:${userId}`;
		status = '';
		error = '';
		const result = await offerTransfer(apiBase, userId, workspace());
		pending = null;
		confirmingId = null;
		if (!result.ok) {
			if (result.reauth) onReauthRequired();
			else error = result.message;
			return;
		}
		status = result.emailSent
			? `We emailed ${address}. ${workspaceName} changes owner when they accept.`
			: `${workspaceName} changes owner when ${address} accepts on this page.`;
		await onChanged();
	}

	// The owner withdraws the offer, or the member it names declines it.
	async function endOffer() {
		pending = 'withdraw';
		status = '';
		error = '';
		const done = await cancelTransfer(apiBase, workspace());
		pending = null;
		if (!done) {
			error = 'We could not end the offer. Try again.';
			return;
		}
		status = owner ? 'You withdrew the offer.' : 'You declined the offer.';
		await onChanged();
	}

	async function accept() {
		pending = 'accept';
		status = '';
		error = '';
		const result = await acceptTransfer(apiBase, workspace());
		pending = null;
		if (!result.ok) {
			error = result.message;
			return;
		}
		status = `You are now the owner of ${workspaceName}.`;
		await onChanged();
	}

	// address is null for an invite link.
	async function cancel(id: string, address: string | null) {
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
		status =
			address === null ? 'Cancelled the invite link.' : `Cancelled the invite to ${address}.`;
		await onChanged();
	}
</script>

<section class="members" aria-labelledby="members-heading">
	<SectionHeader
		id="members-heading"
		title="Members"
		lead={owner
			? `People in ${workspaceName}. Members create and edit links and see analytics. Only you manage domains, ${delivery === 'email' ? 'billing, ' : ''}and members.`
			: `People in ${workspaceName}. Only the workspace owner can invite or remove members. If you leave, your tokens and connected apps for ${workspaceName} stop working.`}
	/>
	<p class="count">
		{page.used} of {page.limit} places used{page.invites.length > 0
			? ', open invites included'
			: ''}.
	</p>

	{#if owner && delivery === 'link'}
		<form class="invite" onsubmit={invite} aria-labelledby="invite-heading">
			<h3 id="invite-heading">Invite a member</h3>
			<div class="row">
				<Button type="submit" variant="primary" disabled={pending !== null || full}
					>{pending === 'invite' ? 'Creating…' : 'Create invite link'}</Button
				>
			</div>
			<p class="hint">
				{full
					? 'All places are used. Cancel an invite or remove a member to free a place, or raise the member limit under Limits.'
					: 'You get a link to send to the person yourself. It works once, for 7 days.'}
			</p>
		</form>
	{:else if owner}
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
	{#if shownLink}
		<Callout tone="info" icon="link" title={shownLink.title}>
			<CopyField id="shown-link" label="Link" value={shownLink.url} />
			<p>{shownLink.note}</p>
			<p class="callout-actions">
				<Button size="sm" onclick={() => (shownLink = null)}>Done</Button>
			</p>
		</Callout>
	{/if}
	{#if page.transfer && owner}
		<Callout tone="info" icon="crown" title="Waiting for {page.transfer.name}">
			<p>
				They become the owner when they accept. The offer is open until
				<time datetime={page.transfer.expiresAt}
					>{dates.format(new Date(page.transfer.expiresAt))}</time
				>.
			</p>
			<p class="callout-actions">
				<Button size="sm" disabled={pending !== null} onclick={() => void endOffer()}
					>{pending === 'withdraw' ? 'Withdrawing…' : 'Withdraw the offer'}</Button
				>
			</p>
		</Callout>
	{:else if page.transfer && offeredToYou}
		<Callout tone="info" icon="crown" title="Become the owner of {workspaceName}?">
			<p>
				The owner offered you {workspaceName}. The owner manages billing, domains, and members, and
				can delete the workspace. The current owner stays as a member.
				{billingNote ?? ''}
			</p>
			<p class="callout-actions">
				<Button
					size="sm"
					variant="primary"
					disabled={pending !== null}
					onclick={() => void accept()}>{pending === 'accept' ? 'Working…' : 'Accept'}</Button
				>
				<Button
					size="sm"
					variant="ghost"
					disabled={pending !== null}
					onclick={() => void endOffer()}
					>{pending === 'withdraw' ? 'Declining…' : 'Decline'}</Button
				>
			</p>
		</Callout>
	{/if}
	<p class="status" role="status" aria-live="polite">{status}</p>
	{#if error}<p class="error" role="alert">{error}</p>{/if}

	<ul class="list" aria-label="Members">
		{#each page.members as member (member.userId)}
			<li class="row-item">
				<Glyph name={member.role === 'owner' ? 'crown' : 'user'} size={22} />
				<span class="who">
					<span class="email">{member.name}</span>
					<span class="meta">Joined {dates.format(new Date(member.joinedAt))}</span>
				</span>
				<span class="badges">
					{#if member.you}<Badge outlined>You</Badge>{/if}
					<Badge tone={member.role === 'owner' ? 'accent' : 'neutral'}
						>{member.role === 'owner' ? 'Owner' : 'Member'}</Badge
					>
				</span>
				{#if member.role === 'member' && (owner || member.you)}
					<span class="actions">
						{#if confirmingId === `owner:${member.userId}`}
							<span class="confirm"
								>Make {member.name} the owner? You become a member. {billingNote ?? ''}</span
							>
							<Button
								size="sm"
								variant="primary"
								disabled={pending !== null}
								onclick={() => void offer(member.userId, member.name)}
								>{pending === `offer:${member.userId}` ? 'Sending…' : 'Send offer'}</Button
							>
							<Button size="sm" variant="ghost" onclick={() => (confirmingId = null)}>Keep</Button>
						{:else if confirmingId === member.userId}
							<span class="confirm"
								>{member.you ? `Leave ${workspaceName}?` : `Remove ${member.name}?`}</span
							>
							<Button
								size="sm"
								variant="danger"
								disabled={pending !== null}
								onclick={() => void remove(member.you ? null : member.userId, member.name)}
								>{pending !== null ? 'Working…' : member.you ? 'Leave' : 'Remove'}</Button
							>
							<Button size="sm" variant="ghost" onclick={() => (confirmingId = null)}>Keep</Button>
						{:else}
							{#if owner && delivery === 'link'}
								<Button
									size="sm"
									disabled={pending !== null}
									aria-label={`Create a password reset link for ${member.name}`}
									onclick={() => void resetLink(member.userId, member.name)}
									>{pending === `reset:${member.userId}` ? 'Creating…' : 'Reset link'}</Button
								>
							{/if}
							{#if owner && page.transfer?.userId !== member.userId}
								<Button
									size="sm"
									disabled={pending !== null}
									aria-label={`Make ${member.name} the owner`}
									onclick={() => (confirmingId = `owner:${member.userId}`)}>Make owner…</Button
								>
							{/if}
							<Button
								size="sm"
								variant="danger-soft"
								disabled={pending !== null}
								aria-label={member.you ? `Leave ${workspaceName}` : `Remove ${member.name}`}
								onclick={() => (confirmingId = member.userId)}
								>{member.you ? 'Leave…' : 'Remove…'}</Button
							>
						{/if}
					</span>
				{/if}
			</li>
		{/each}
	</ul>

	{#if owner && page.invites.length > 0}
		<h3 class="small-heading" id="invites-heading">Open invites</h3>
		<ul class="list" aria-labelledby="invites-heading">
			{#each page.invites as item (item.id)}
				<li class="row-item">
					<Glyph name={item.email === null ? 'link' : 'envelope'} size={22} />
					<span class="who">
						<span class="email">{item.email ?? 'Invite link'}</span>
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
							{#if item.email !== null}
								{@const address = item.email}
								<Button
									size="sm"
									disabled={pending !== null}
									aria-label={`Send the invite to ${address} again`}
									onclick={() => void resend(item.id, address)}
									>{pending === `resend:${item.id}` ? 'Sending…' : 'Send again'}</Button
								>
							{/if}
							<Button
								size="sm"
								variant="danger-soft"
								disabled={pending !== null}
								aria-label={item.email === null
									? 'Cancel the invite link'
									: `Cancel the invite to ${item.email}`}
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
	.callout-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin-top: 0.6rem;
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
