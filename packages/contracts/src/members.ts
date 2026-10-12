// SPDX-License-Identifier: AGPL-3.0-only
// A workspace's members and invites, for the dashboard. All of these routes take a session only.
import { LinkInputError } from './links';
import { isWorkspace, type Workspace, type WorkspaceRole } from './workspace';

export interface WorkspaceMember {
	userId: string;
	email: string;
	// What the person signs in with: the email in the cloud, the username in standalone.
	name: string;
	role: WorkspaceRole;
	joinedAt: string;
	// The signed-in person.
	you: boolean;
}

export interface WorkspaceInvite {
	id: string;
	// null for an invite shared as a link.
	email: string | null;
	createdAt: string;
	expiresAt: string;
}

// The owner's open offer to make a member the owner.
export interface OwnershipOffer {
	userId: string;
	email: string;
	name: string;
	expiresAt: string;
}

// invites is empty for a member: only the owner sees and manages them. used counts members and
// open invites against limit. transfer is shown to the owner and to the member it names only.
export interface MemberPage {
	members: WorkspaceMember[];
	invites: WorkspaceInvite[];
	used: number;
	limit: number;
	transfer: OwnershipOffer | null;
}

// What an invite page shows before the person accepts.
export interface InvitePreview {
	workspaceName: string;
	// The address the invite is for, in lower case.
	email: string;
	expiresAt: string;
	// The signed-in person's address is the invited one.
	forYou: boolean;
}

export interface AcceptedInvite {
	workspace: Workspace;
}

// The answer to POST /v1/invites and a resend. url is the invite link, shown once, for an
// installation that shares invites as links; emailSent is then false.
export interface CreatedInvite {
	invite: WorkspaceInvite;
	emailSent: boolean;
	url?: string;
}

// The answer to POST /v1/members/:userId/password-reset: the link, shown once.
export interface PasswordResetLink {
	url: string;
	expiresAt: string;
}

// What an invite link shows before the person creates an account, in standalone.
export interface LinkInvitePreview {
	workspaceName: string;
	expiresAt: string;
}

// What a password reset link shows before the person sets a new password.
export interface PasswordResetPreview {
	username: string;
	workspaceName: string;
	expiresAt: string;
}

export const inviteLifetimeDays = 7;
export const transferLifetimeDays = 7;
export const maxEmailLength = 254;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function onlyKeys(body: Record<string, unknown>, allowed: string): void {
	for (const key of Object.keys(body))
		if (key !== allowed) throw new LinkInputError(key, `Unknown field: ${key}.`);
}

// Trimmed and in lower case, or null for anything that is not a plain address.
export function normalizeEmail(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const email = value.trim().toLowerCase();
	if (email.length > maxEmailLength) return null;
	return /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[^\s@<>()",;:\\[\]]+$/.test(email)
		? email
		: null;
}

// The body of POST /v1/invites.
export function parseInvite(body: unknown): { email: string } {
	if (!isRecord(body)) throw new LinkInputError('body', 'Send a JSON object.');
	onlyKeys(body, 'email');
	const email = normalizeEmail(body.email);
	if (email === null) throw new LinkInputError('email', 'Enter an email address.');
	return { email };
}

// The body of POST /v1/invites for an invite shared as a link: an empty object.
export function parseLinkInvite(body: unknown): void {
	if (!isRecord(body)) throw new LinkInputError('body', 'Send a JSON object.');
	for (const key of Object.keys(body)) throw new LinkInputError(key, `Unknown field: ${key}.`);
}

// The body of POST /v1/invites/lookup and /v1/invites/accept. The token comes from the invite
// link's fragment.
export function parseInviteToken(body: unknown): { token: string } {
	if (!isRecord(body)) throw new LinkInputError('body', 'Send a JSON object.');
	onlyKeys(body, 'token');
	const { token } = body;
	if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,100}$/.test(token))
		throw new LinkInputError('token', 'This invite link is not complete.');
	return { token };
}

// The body of POST /v1/workspace/transfer: the member who would become the owner.
export function parseTransfer(body: unknown): { userId: string } {
	if (!isRecord(body)) throw new LinkInputError('body', 'Send a JSON object.');
	onlyKeys(body, 'userId');
	const { userId } = body;
	if (typeof userId !== 'string' || userId.length < 1 || userId.length > 64)
		throw new LinkInputError('userId', 'Choose a member.');
	return { userId };
}

const roles: readonly string[] = ['owner', 'member'] satisfies WorkspaceRole[];

function isMember(value: unknown): value is WorkspaceMember {
	return (
		isRecord(value) &&
		typeof value.userId === 'string' &&
		typeof value.email === 'string' &&
		typeof value.name === 'string' &&
		typeof value.role === 'string' &&
		roles.includes(value.role) &&
		typeof value.joinedAt === 'string' &&
		typeof value.you === 'boolean'
	);
}

export function isWorkspaceInvite(value: unknown): value is WorkspaceInvite {
	return (
		isRecord(value) &&
		typeof value.id === 'string' &&
		(value.email === null || typeof value.email === 'string') &&
		typeof value.createdAt === 'string' &&
		typeof value.expiresAt === 'string'
	);
}

export function isOwnershipOffer(value: unknown): value is OwnershipOffer {
	return (
		isRecord(value) &&
		typeof value.userId === 'string' &&
		typeof value.email === 'string' &&
		typeof value.name === 'string' &&
		typeof value.expiresAt === 'string'
	);
}

export function isMemberPage(value: unknown): value is MemberPage {
	return (
		isRecord(value) &&
		Array.isArray(value.members) &&
		value.members.every(isMember) &&
		Array.isArray(value.invites) &&
		value.invites.every(isWorkspaceInvite) &&
		typeof value.used === 'number' &&
		typeof value.limit === 'number' &&
		(value.transfer === null || isOwnershipOffer(value.transfer))
	);
}

export function isInvitePreview(value: unknown): value is InvitePreview {
	return (
		isRecord(value) &&
		typeof value.workspaceName === 'string' &&
		typeof value.email === 'string' &&
		typeof value.expiresAt === 'string' &&
		typeof value.forYou === 'boolean'
	);
}

export function isAcceptedInvite(value: unknown): value is AcceptedInvite {
	return isRecord(value) && isWorkspace(value.workspace);
}

export function isLinkInvitePreview(value: unknown): value is LinkInvitePreview {
	return (
		isRecord(value) &&
		typeof value.workspaceName === 'string' &&
		typeof value.expiresAt === 'string'
	);
}

export function isPasswordResetPreview(value: unknown): value is PasswordResetPreview {
	return (
		isRecord(value) &&
		typeof value.username === 'string' &&
		typeof value.workspaceName === 'string' &&
		typeof value.expiresAt === 'string'
	);
}

export function isPasswordResetLink(value: unknown): value is PasswordResetLink {
	return isRecord(value) && typeof value.url === 'string' && typeof value.expiresAt === 'string';
}
