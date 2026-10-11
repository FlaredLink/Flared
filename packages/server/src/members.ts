// SPDX-License-Identifier: AGPL-3.0-only
// Invite tokens and the invite email. The token is in the email only: the store keeps its hash,
// and the link carries it in the fragment, so no server log or Referer header receives it.
import type { EmailContent, EmailTransport } from './email/transport';

export interface InviteSettings {
	email: EmailTransport;
	// The page that accepts an invite, with the token in the fragment, such as
	// https://example.com/app/invite#<token>.
	inviteUrl(token: string): string;
	// Invite emails each workspace may send in a UTC day. 20 when absent.
	emailsPerDay?: number;
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
