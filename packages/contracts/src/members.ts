// SPDX-License-Identifier: AGPL-3.0-only
// A workspace's members and invites, for the dashboard. All of these routes take a session only.
import { LinkInputError } from './links';
import { isWorkspace, type Workspace, type WorkspaceRole } from './workspace';

export interface WorkspaceMember {
	userId: string;
	email: string;
	role: WorkspaceRole;
	joinedAt: string;
	// The signed-in person.
	you: boolean;
}

export interface WorkspaceInvite {
	id: string;
	email: string;
	createdAt: string;
	expiresAt: string;
}

// invites is empty for a member: only the owner sees and manages them. used counts members and
// open invites against limit.
export interface MemberPage {
	members: WorkspaceMember[];
	invites: WorkspaceInvite[];
	used: number;
	limit: number;
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

export const inviteLifetimeDays = 7;
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

const roles: readonly string[] = ['owner', 'member'] satisfies WorkspaceRole[];

function isMember(value: unknown): value is WorkspaceMember {
	return (
		isRecord(value) &&
		typeof value.userId === 'string' &&
		typeof value.email === 'string' &&
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
		typeof value.email === 'string' &&
		typeof value.createdAt === 'string' &&
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
		typeof value.limit === 'number'
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
