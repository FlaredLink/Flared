// SPDX-License-Identifier: AGPL-3.0-only
// Invite and reset tokens, and the invite email. The token is in the email or the shown link
// only: the store keeps its hash, and the link carries it in the fragment, so no server log or
// Referer header receives it.
import type { EmailContent, EmailTransport } from './email/transport';

// How an installation invites members: by email to one address (the cloud), or as a link that
// the owner shares and that creates a username account (standalone).
export type InviteSettings = EmailInviteSettings | LinkInviteSettings;

export interface EmailInviteSettings {
	delivery: 'email';
	email: EmailTransport;
	// The page that accepts an invite, with the token in the fragment, such as
	// https://example.com/app/invite#<token>.
	inviteUrl(token: string): string;
	// The page that lists the members, where a member accepts an offer of the workspace, such as
	// https://example.com/app/settings?tab=members.
	membersUrl: string;
	// Invite emails each workspace may send in a UTC day. 20 when absent.
	emailsPerDay?: number;
}

export interface LinkInviteSettings {
	delivery: 'link';
	// The page that creates an account from an invite, with the token in the fragment.
	inviteUrl(token: string): string;
	// The page that sets a member's new password, with the token in the fragment.
	resetUrl(token: string): string;
	// Invite and reset links each workspace may create in a UTC day. 20 when absent.
	linksPerDay?: number;
}

// The links or emails of each workspace per UTC day.
export function invitesPerDay(settings: InviteSettings): number {
	return (settings.delivery === 'email' ? settings.emailsPerDay : settings.linksPerDay) ?? 20;
}

function base64url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// 32 random bytes: 43 characters.
export function newInviteToken(): string {
	return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function hashInviteToken(token: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
	return base64url(new Uint8Array(digest));
}

function escape(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;');
}

export function inviteEmail(input: {
	to: string;
	workspaceName: string;
	// The owner's address, so the person knows who sent the invite.
	invitedBy: string;
	url: string;
	expiresAt: number;
}): EmailContent {
	const { to, workspaceName, invitedBy, url } = input;
	const until = new Date(input.expiresAt).toUTCString().replace(/:\d\d GMT$/, ' UTC');
	const lines = [
		`${invitedBy} invited you to the workspace "${workspaceName}" on Flared.`,
		'Members create and edit short links and see their analytics.',
		`Accept the invite: ${url}`,
		`Sign in with ${to} to accept. The link works once, until ${until}.`,
		'If you did not expect this invite, ignore this email.'
	];
	const html = lines
		.map((line) =>
			line.startsWith('Accept the invite')
				? `<p><a href="${escape(url)}">Accept the invite</a></p>`
				: `<p>${escape(line)}</p>`
		)
		.join('');
	return {
		to,
		subject: `Join the workspace "${workspaceName}" on Flared`,
		text: lines.join('\n\n'),
		html
	};
}

// Tells a member that the owner offered them the workspace. The member accepts on the members
// page while the workspace is the one shown, so the email says how to get there.
export function transferEmail(input: {
	to: string;
	workspaceName: string;
	// The owner's address.
	from: string;
	url: string;
	expiresAt: number;
}): EmailContent {
	const { to, workspaceName, from, url } = input;
	const until = new Date(input.expiresAt).toUTCString().replace(/:\d\d GMT$/, ' UTC');
	const lines = [
		`${from} wants to make you the owner of the workspace "${workspaceName}" on Flared.`,
		'The owner manages billing, domains, and members. If you accept, they stay as a member.',
		`Open the members page: ${url}`,
		`Choose "${workspaceName}" in the workspace menu, then accept or decline. The offer is open until ${until}.`,
		'If you did not expect this, ignore this email or decline the offer.'
	];
	const html = lines
		.map((line) =>
			line.startsWith('Open the members page')
				? `<p><a href="${escape(url)}">Open the members page</a></p>`
				: `<p>${escape(line)}</p>`
		)
		.join('');
	return {
		to,
		subject: `Become the owner of "${workspaceName}" on Flared`,
		text: lines.join('\n\n'),
		html
	};
}
