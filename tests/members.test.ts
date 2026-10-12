// SPDX-License-Identifier: AGPL-3.0-only
// Invites by email: single use, bound to one address, within the member limit, and ended by
// expiry, cancellation, or a resend.
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import {
	createAccountDeletion,
	deleteIdentityRecords,
	deleteMemberOnlyUser
} from '../packages/data/src/deletions';
import {
	deleteExpiredMemberEvents,
	listMemberEvents,
	memberEventLifetimeMs,
	ownershipTransferStatements,
	transferred
} from '../packages/data/src/members';
import { createTenant, type PolicyLimits } from '../packages/data/src/tenancy';
import { createApi, type ApiDependencies } from '../packages/server/src/api';
import { workspaceHeader } from '../packages/contracts/src/workspace';
import type { EmailContent } from '../packages/server/src/email/transport';
import { projectPolicy } from '../packages/server/src/tenancy';

const origin = 'https://app.example';
const identity = () => env.MEMBERS_IDENTITY;
const dayMs = 86_400_000;
let clock = Date.UTC(2026, 9, 11, 12);
const sent: EmailContent[] = [];
let failEmail = false;

function limits(memberLimit: number): PolicyLimits {
	return {
		activeLinkLimit: 100,
		monthlyClickLimit: 5000,
		retentionDays: 30,
		domainLimit: 1,
		memberLimit
	};
}

async function addUser(userId: string) {
	await identity()
		.prepare(
			'INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 0, 0)'
		)
		.bind(userId, '', `${userId}@example.com`)
		.run();
	await identity()
		.prepare(
			'INSERT INTO "session" (id, expiresAt, token, createdAt, updatedAt, userId) VALUES (?, ?, ?, 0, 0, ?)'
		)
		.bind(`sess-${userId}`, Date.now() + dayMs, `token-${userId}`, userId)
		.run();
}

async function addWorkspace(tenantId: string, name: string, ownerUserId: string, members: number) {
	await createTenant(identity(), {
		id: tenantId,
		name,
		ownerUserId,
		analyticsShardId: 'analytics-1',
		limits: limits(members),
		now: 1
	});
	await projectPolicy(
		identity(),
		{ routing: env.MEMBERS_ROUTING, analytics: { 'analytics-1': env.MEMBERS_ANALYTICS } },
		tenantId,
		1
	);
}

function api(emailsPerDay?: number, extra: Partial<ApiDependencies> = {}) {
	return createApi({
		identity: identity(),
		routing: env.MEMBERS_ROUTING,
		analytics: { 'analytics-1': env.MEMBERS_ANALYTICS },
		appOrigin: origin,
		now: () => clock,
		invites: {
			delivery: 'email',
			email: {
				async send(message) {
					if (failEmail) throw new Error('No email');
					sent.push(message);
				}
			},
			inviteUrl: (token) => `${origin}/app/invite#${token}`,
			membersUrl: `${origin}/app/settings?tab=members`,
			emailsPerDay
		},
		authenticate: async (request) => {
			const sessionId = request.headers.get('x-test-session');
			const row = sessionId
				? await identity()
						.prepare('SELECT "userId" FROM "session" WHERE id = ?')
						.bind(sessionId)
						.first<{ userId: string }>()
				: null;
			if (!sessionId || !row) return null;
			return {
				kind: 'session',
				userId: row.userId,
				sessionId,
				signedInAt: request.headers.get('x-test-signed-in') ?? new Date(clock).toISOString()
			};
		},
		...extra
	});
}

async function call(
	userId: string,
	method: string,
	path: string,
	body?: unknown,
	app = api(),
	extra: Record<string, string> = {}
) {
	const headers: Record<string, string> = { 'x-test-session': `sess-${userId}`, origin, ...extra };
	const init: RequestInit = { method, headers };
	if (body !== undefined) {
		init.body = JSON.stringify(body);
		headers['content-type'] = 'application/json';
	}
	const response = await app.fetch(new Request(`${origin}/v1${path}`, init));
	const text = await response.text();
	return { status: response.status, body: text ? (JSON.parse(text) as Record<string, any>) : {} };
}

// The token from the newest invite email.
function lastToken(): string {
	const match = /#([A-Za-z0-9_-]+)/.exec(sent.at(-1)?.text ?? '');
	if (!match) throw new Error('No invite email');
	return match[1];
}

const invite = (owner: string, email: string, app?: ReturnType<typeof api>) =>
	call(owner, 'POST', '/invites', { email }, app);
const accept = (userId: string, token: string) =>
	call(userId, 'POST', '/invites/accept', { token });

beforeAll(async () => {
	await applyD1Migrations(identity(), env.IDENTITY_MIGRATIONS, 'flared_core_migrations');
	await identity()
		.prepare("INSERT INTO installation (id, mode, created_at) VALUES (1, 'multi', 0)")
		.run();
	await applyD1Migrations(env.MEMBERS_ROUTING, env.ROUTING_MIGRATIONS, 'flared_core_migrations');
	await applyD1Migrations(
		env.MEMBERS_ANALYTICS,
		env.ANALYTICS_MIGRATIONS,
		'flared_core_migrations'
	);
	for (const userId of ['own', 'mia', 'ned', 'oli', 'pat', 'rex', 'sam', 'tia'])
		await addUser(userId);
	await addWorkspace('ws-team', 'Team <One>', 'own', 4);
	await addWorkspace('ws-race', 'Race', 'rex', 2);
	await addWorkspace('ws-gone', 'Gone', 'tia', 5);
});

describe('invites', () => {
	it('sends an invite that the invited person accepts once', async () => {
		const created = await invite('own', ' Mia@Example.com ');
		expect(created.status).toBe(201);
		expect(created.body.emailSent).toBe(true);
		expect(created.body.invite).toMatchObject({ email: 'mia@example.com' });
		const email = sent.at(-1);
		expect(email?.to).toBe('mia@example.com');
		expect(email?.subject).toBe('Join the workspace "Team <One>" on Flared');
		expect(email?.text).toContain('own@example.com invited you');
		expect(email?.html).toContain('Team &lt;One&gt;');
		const token = lastToken();
		expect(email?.text).toContain(`${origin}/app/invite#${token}`);

		const preview = await call('mia', 'POST', '/invites/lookup', { token });
		expect(preview.body).toMatchObject({
			workspaceName: 'Team <One>',
			email: 'mia@example.com',
			forYou: true
		});
		const joined = await accept('mia', token);
		expect(joined.status).toBe(200);
		expect(joined.body.workspace).toEqual({ id: 'ws-team', name: 'Team <One>', role: 'member' });
		// The session now acts in the joined workspace.
		expect((await call('mia', 'GET', '/workspace')).body.workspace.id).toBe('ws-team');

		const replay = await accept('mia', token);
		expect([replay.status, replay.body.error.code]).toEqual([404, 'NOT_FOUND']);

		const page = await call('own', 'GET', '/members');
		expect(page.body).toMatchObject({ used: 2, limit: 4, invites: [] });
		expect(
			page.body.members.map((member: { email: string; role: string; you: boolean }) => [
				member.email,
				member.role,
				member.you
			])
		).toEqual([
			['own@example.com', 'owner', true],
			['mia@example.com', 'member', false]
		]);
	});

	it('works only for the address it was sent to', async () => {
		await invite('own', 'ned@example.com');
		const token = lastToken();
		const lookup = await call('oli', 'POST', '/invites/lookup', { token });
		expect(lookup.body.forYou).toBe(false);
		const refused = await accept('oli', token);
		expect([refused.status, refused.body.error.code]).toEqual([403, 'INVITE_FOR_ANOTHER_EMAIL']);
		expect((await accept('ned', token)).status).toBe(200);
	});

	it('refuses a second invite to the same address and an invite to a member', async () => {
		const member = await invite('own', 'mia@example.com');
		expect([member.status, member.body.error.code]).toEqual([409, 'ALREADY_MEMBER']);
		await invite('own', 'oli@example.com');
		const twice = await invite('own', 'oli@example.com');
		expect([twice.status, twice.body.error.code]).toEqual([409, 'INVITE_PENDING']);
		// A member sees the members but not the invites, and cannot invite.
		const page = await call('mia', 'GET', '/members');
		expect(page.body).toMatchObject({ used: 4, limit: 4, invites: [] });
		const byMember = await invite('mia', 'pat@example.com');
		expect([byMember.status, byMember.body.error.code]).toEqual([403, 'OWNER_REQUIRED']);
	});

	it('ends the old link when the invite is sent again', async () => {
		const page = await call('own', 'GET', '/members');
		const open = page.body.invites[0] as { id: string; email: string };
		expect(open.email).toBe('oli@example.com');
		const old = lastToken();
		const resent = await call('own', 'POST', `/invites/${open.id}/resend`);
		expect(resent.status).toBe(200);
		const fresh = lastToken();
		expect(fresh).not.toBe(old);
		expect((await accept('oli', old)).status).toBe(404);
		// The workspace is full: the resend kept its one place.
		const full = await invite('own', 'pat@example.com');
		expect([full.status, full.body.error.code]).toEqual([403, 'MEMBER_LIMIT_REACHED']);
		expect((await accept('oli', fresh)).status).toBe(200);
	});

	it('lets one of several invites at once take the last place', async () => {
		const results = await Promise.all(
			['mia', 'ned', 'oli', 'pat', 'sam'].map((userId) => invite('rex', `${userId}@example.com`))
		);
		expect(results.map((result) => result.status).sort()).toEqual([201, 403, 403, 403, 403]);
		const page = await call('rex', 'GET', '/members');
		expect(page.body).toMatchObject({ used: 2, limit: 2 });
	});

	it('frees the place of a cancelled invite and refuses its link', async () => {
		const page = await call('rex', 'GET', '/members');
		const open = page.body.invites[0] as { id: string; email: string };
		const token = lastToken();
		const userId = open.email.split('@')[0];
		expect((await call('rex', 'DELETE', `/invites/${open.id}`)).status).toBe(204);
		expect((await accept(userId, token)).status).toBe(404);
		expect((await invite('rex', 'sam@example.com')).status).toBe(201);
	});

	it('ends an invite after seven days and frees its place', async () => {
		const token = lastToken();
		clock += 7 * dayMs + 1;
		expect((await accept('sam', token)).status).toBe(404);
		expect((await call('sam', 'POST', '/invites/lookup', { token })).status).toBe(404);
		expect((await call('rex', 'GET', '/members')).body).toMatchObject({ used: 1, invites: [] });
		// The same address can be invited again.
		expect((await invite('rex', 'sam@example.com')).status).toBe(201);
		expect((await accept('sam', lastToken())).status).toBe(200);
	});

	it('keeps an invite whose email failed, so the owner can send it again', async () => {
		failEmail = true;
		const created = await invite('tia', 'pat@example.com');
		failEmail = false;
		expect([created.status, created.body.emailSent]).toEqual([201, false]);
		const resent = await call('tia', 'POST', `/invites/${created.body.invite.id}/resend`);
		expect([resent.status, resent.body.emailSent]).toEqual([200, true]);
	});

	it('limits the invite emails of a workspace each day', async () => {
		clock += dayMs;
		const app = api(1);
		expect((await invite('tia', 'a1@example.com', app)).status).toBe(201);
		const limited = await invite('tia', 'a2@example.com', app);
		expect([limited.status, limited.body.error.code]).toEqual([429, 'RATE_LIMITED']);
		clock += dayMs;
		expect((await invite('tia', 'a2@example.com', app)).status).toBe(201);
	});

	it('removes open invites with the workspace', async () => {
		await deleteIdentityRecords(identity(), 'ws-gone', 'tia', clock);
		const left = await identity()
			.prepare("SELECT COUNT(*) AS n FROM tenant_invites WHERE tenant_id = 'ws-gone'")
			.first<{ n: number }>();
		expect(left?.n).toBe(0);
	});
});

describe('removal and leaving', () => {
	async function rows(sql: string, ...values: string[]): Promise<number> {
		const row = await identity()
			.prepare(`SELECT COUNT(*) AS n FROM ${sql}`)
			.bind(...values)
			.first<{ n: number }>();
		return row?.n ?? -1;
	}

	beforeAll(async () => {
		// ned is a member of ws-team and owns ws-ned; each workspace has one of ned's tokens.
		await addWorkspace('ws-ned', 'Ned', 'ned', 2);
		const db = identity();
		await db.batch([
			db.prepare(
				"INSERT INTO apikey (id, referenceId, key, createdAt, updatedAt, metadata) VALUES ('key-team', 'ned', 'h-team', 0, 0, '{\"tenantId\":\"ws-team\"}'), ('key-own', 'ned', 'h-own', 0, 0, '{\"tenantId\":\"ws-ned\"}')"
			),
			db.prepare(
				"INSERT INTO oauthClient (id, clientId, redirectUris) VALUES ('client-1', 'client-1', '[]')"
			),
			db.prepare(
				"INSERT INTO oauthConsent (id, clientId, userId, referenceId, scopes) VALUES ('consent-team', 'client-1', 'ned', 'ws-team', '[]'), ('consent-own', 'client-1', 'ned', 'ws-ned', '[]')"
			),
			db.prepare(
				"INSERT OR REPLACE INTO session_workspaces (session_id, tenant_id, updated_at) VALUES ('sess-ned', 'ws-team', 1)"
			)
		]);
	});

	it('removes a member with the credentials for that workspace only', async () => {
		const self = await call('own', 'DELETE', '/members/own');
		expect([self.status, self.body.error.code]).toEqual([409, 'OWNER_CANNOT_LEAVE']);
		const byMember = await call('mia', 'DELETE', '/members/ned');
		expect([byMember.status, byMember.body.error.code]).toEqual([403, 'OWNER_REQUIRED']);

		expect((await call('own', 'DELETE', '/members/ned')).status).toBe(204);
		expect(await rows("tenant_memberships WHERE user_id = 'ned'")).toBe(1);
		expect(await rows("apikey WHERE referenceId = 'ned'")).toBe(1);
		expect(await rows("apikey WHERE id = 'key-own'")).toBe(1);
		expect(await rows("oauthConsent WHERE id = 'consent-own'")).toBe(1);
		expect(await rows("oauthConsent WHERE id = 'consent-team'")).toBe(0);
		// The session falls back to the workspace ned still has.
		expect((await call('ned', 'GET', '/workspace')).body.workspace.id).toBe('ws-ned');
		expect((await call('own', 'DELETE', '/members/ned')).status).toBe(404);
	});

	it('lets a member leave and keeps the owner', async () => {
		const owner = await call('own', 'POST', '/workspace/leave', undefined, api(), {
			[workspaceHeader]: 'ws-team'
		});
		expect([owner.status, owner.body.error.code]).toEqual([409, 'OWNER_CANNOT_LEAVE']);
		// Without the workspace the page shows, nothing changes.
		const unnamed = await call('mia', 'POST', '/workspace/leave');
		expect([unnamed.status, unnamed.body.error.code]).toEqual([409, 'WORKSPACE_CHANGED']);
		const left = await call('mia', 'POST', '/workspace/leave', undefined, api(), {
			[workspaceHeader]: 'ws-team'
		});
		expect(left.status).toBe(204);
		const after = await call('mia', 'GET', '/links');
		expect([after.status, after.body.error.code]).toEqual([403, 'NO_WORKSPACE']);
	});

	it('deletes a person who owns no workspace, and never an owner', async () => {
		expect(await deleteMemberOnlyUser(identity(), 'own', clock)).toBe(false);
		expect(await rows("user WHERE id = 'own'")).toBe(1);
		expect(await rows("tenant_memberships WHERE user_id = 'oli'")).toBe(1);
		expect(await deleteMemberOnlyUser(identity(), 'oli', clock)).toBe(true);
		expect(await rows("user WHERE id = 'oli'")).toBe(0);
		expect(await rows("tenant_memberships WHERE user_id = 'oli'")).toBe(0);
		expect(await rows('"session" WHERE "userId" = \'oli\'')).toBe(0);
		expect(await rows("tenant_memberships WHERE tenant_id = 'ws-team'")).toBe(1);
	});
});

describe('ownership transfer', () => {
	const shown = { [workspaceHeader]: 'ws-move' };
	const offer = (
		userId: string,
		target: string,
		app = api(),
		extra: Record<string, string> = shown
	) => call(userId, 'POST', '/workspace/transfer', { userId: target }, app, extra);
	const acceptOffer = (userId: string, app = api()) =>
		call(userId, 'POST', '/workspace/transfer/accept', undefined, app, shown);
	const endOffer = (userId: string) =>
		call(userId, 'DELETE', '/workspace/transfer', undefined, api(), shown);
	const role = async (userId: string) =>
		(
			await identity()
				.prepare("SELECT role FROM tenant_memberships WHERE tenant_id = 'ws-move' AND user_id = ?")
				.bind(userId)
				.first<{ role: string }>()
		)?.role ?? null;
	const members = (userId: string) => call(userId, 'GET', '/members', undefined, api(), shown);

	beforeAll(async () => {
		for (const userId of ['ava', 'ben', 'cal']) await addUser(userId);
		await addWorkspace('ws-move', 'Move', 'ava', 5);
		await identity()
			.prepare(
				"INSERT INTO tenant_memberships (tenant_id, user_id, role, created_at) VALUES ('ws-move', 'ben', 'member', 2), ('ws-move', 'cal', 'member', 3)"
			)
			.run();
		for (const userId of ['ava', 'ben', 'cal'])
			await identity()
				.prepare(
					'INSERT OR REPLACE INTO session_workspaces (session_id, tenant_id, updated_at) VALUES (?, ?, 1)'
				)
				.bind(`sess-${userId}`, 'ws-move')
				.run();
	});

	it('makes the member who accepts the owner, and the owner a member', async () => {
		const byMember = await offer('cal', 'ben');
		expect([byMember.status, byMember.body.error.code]).toEqual([403, 'OWNER_REQUIRED']);
		const unnamed = await offer('ava', 'ben', api(), {});
		expect([unnamed.status, unnamed.body.error.code]).toEqual([409, 'WORKSPACE_CHANGED']);
		const stale = await offer('ava', 'ben', api(), {
			...shown,
			'x-test-signed-in': new Date(clock - dayMs).toISOString()
		});
		expect([stale.status, stale.body.error.code]).toEqual([403, 'REAUTH_REQUIRED']);
		expect((await offer('ava', 'nobody')).status).toBe(404);
		expect((await offer('ava', 'ava')).status).toBe(404);

		const offered = await offer('ava', 'ben');
		expect(offered.status).toBe(201);
		expect(offered.body).toMatchObject({
			transfer: { userId: 'ben', email: 'ben@example.com' },
			emailSent: true
		});
		expect(sent.at(-1)).toMatchObject({
			to: 'ben@example.com',
			subject: 'Become the owner of "Move" on Flared'
		});
		expect(sent.at(-1)?.text).toContain(`${origin}/app/settings?tab=members`);
		// The owner and the member it names see the offer; other members do not.
		expect((await members('ava')).body.transfer.userId).toBe('ben');
		expect((await members('ben')).body.transfer.userId).toBe('ben');
		expect((await members('cal')).body.transfer).toBeNull();
		// Only the member it names can accept it.
		expect((await acceptOffer('cal')).status).toBe(404);
		expect((await acceptOffer('ava')).status).toBe(404);

		const accepted = await acceptOffer('ben');
		expect(accepted.status).toBe(200);
		expect(accepted.body.workspace).toEqual({ id: 'ws-move', name: 'Move', role: 'owner' });
		expect([await role('ava'), await role('ben'), await role('cal')]).toEqual([
			'member',
			'owner',
			'member'
		]);
		expect((await members('ben')).body.transfer).toBeNull();
		expect((await acceptOffer('ben')).status).toBe(404);
		// The roles apply at once: the former owner can no longer rename the workspace.
		const rename = await call('ava', 'PATCH', '/workspace', { name: 'Mine' }, api(), shown);
		expect([rename.status, rename.body.error.code]).toEqual([403, 'OWNER_REQUIRED']);
		// The new owner can give it back.
		expect((await offer('ben', 'ava')).status).toBe(201);
		expect((await acceptOffer('ava')).status).toBe(200);
		expect([await role('ava'), await role('ben')]).toEqual(['owner', 'member']);
	});

	it('ends an offer that is withdrawn, declined, expired, or for a removed member', async () => {
		expect((await offer('ava', 'ben')).status).toBe(201);
		expect((await endOffer('cal')).status).toBe(404);
		expect((await endOffer('ava')).status).toBe(204);
		expect((await acceptOffer('ben')).status).toBe(404);

		expect((await offer('ava', 'ben')).status).toBe(201);
		expect((await endOffer('ben')).status).toBe(204);
		expect((await acceptOffer('ben')).status).toBe(404);

		// A new offer replaces the open one.
		expect((await offer('ava', 'ben')).status).toBe(201);
		expect((await offer('ava', 'cal')).status).toBe(201);
		expect((await acceptOffer('ben')).status).toBe(404);
		clock += 7 * dayMs + 1;
		expect((await acceptOffer('cal')).status).toBe(404);
		expect((await members('ava')).body.transfer).toBeNull();

		// A removed member's offer does not come back when they join again.
		expect((await offer('ava', 'cal')).status).toBe(201);
		expect((await call('ava', 'DELETE', '/members/cal')).status).toBe(204);
		await identity()
			.prepare(
				"INSERT INTO tenant_memberships (tenant_id, user_id, role, created_at) VALUES ('ws-move', 'cal', 'member', 4)"
			)
			.run();
		expect((await members('ava')).body.transfer).toBeNull();
		expect([await role('ava'), await role('cal')]).toEqual(['owner', 'member']);
	});

	it('changes nothing when the edition’s condition fails', async () => {
		expect((await offer('ava', 'ben')).status).toBe(201);
		const db = identity();
		const input = { tenantId: 'ws-move', toUserId: 'ben', now: clock };
		expect(transferred(await db.batch(ownershipTransferStatements(db, input, '0')))).toBe(false);
		expect([await role('ava'), await role('ben')]).toEqual(['owner', 'member']);
		expect((await members('ben')).body.transfer.userId).toBe('ben');

		const limited = api(undefined, {
			transferOwnership: async () => ({ status: 'limit', message: 'You own a Free workspace.' })
		});
		const refused = await acceptOffer('ben', limited);
		expect([refused.status, refused.body.error]).toMatchObject([
			403,
			{ code: 'WORKSPACE_LIMIT_REACHED', message: 'You own a Free workspace.' }
		]);
		expect(await role('ava')).toBe('owner');
		expect((await endOffer('ava')).status).toBe(204);
	});
});

describe('member events', () => {
	const shown = { [workspaceHeader]: 'ws-log' };
	// Oldest first, as [action, actor, subject].
	const events = async () =>
		(await listMemberEvents(identity(), 'ws-log', 200))
			.reverse()
			.map((event) => [event.action, event.actorUserId, event.subjectUserId]);

	beforeAll(async () => {
		for (const userId of ['eve', 'fay', 'gus', 'hal']) await addUser(userId);
		await addWorkspace('ws-log', 'Log', 'eve', 5);
	});

	it('records each member change once, with user IDs and no address or token', async () => {
		const first = await invite('eve', 'fay@example.com');
		expect(first.status).toBe(201);
		expect((await call('eve', 'POST', `/invites/${first.body.invite.id}/resend`)).status).toBe(200);
		const token = lastToken();
		expect((await accept('fay', token)).status).toBe(200);
		// Refused changes record nothing.
		expect((await invite('eve', 'fay@example.com')).status).toBe(409);
		expect((await accept('fay', token)).status).toBe(404);
		expect((await call('eve', 'DELETE', '/members/eve')).status).toBe(409);
		expect((await call('eve', 'DELETE', '/invites/none')).status).toBe(404);

		const second = await invite('eve', 'gus@example.com');
		expect((await call('eve', 'DELETE', `/invites/${second.body.invite.id}`)).status).toBe(204);
		expect((await invite('eve', 'gus@example.com')).status).toBe(201);
		expect((await accept('gus', lastToken())).status).toBe(200);
		expect((await call('eve', 'DELETE', '/members/gus')).status).toBe(204);

		const offer = () => call('eve', 'POST', '/workspace/transfer', { userId: 'fay' }, api(), shown);
		const endOffer = (userId: string) =>
			call(userId, 'DELETE', '/workspace/transfer', undefined, api(), shown);
		expect((await offer()).status).toBe(201);
		expect((await endOffer('eve')).status).toBe(204);
		expect((await endOffer('eve')).status).toBe(404);
		expect((await offer()).status).toBe(201);
		expect((await endOffer('fay')).status).toBe(204);
		expect((await offer()).status).toBe(201);
		const db = identity();
		const input = { tenantId: 'ws-log', toUserId: 'fay', now: clock };
		expect(transferred(await db.batch(ownershipTransferStatements(db, input, '0')))).toBe(false);
		expect(
			(await call('fay', 'POST', '/workspace/transfer/accept', undefined, api(), shown)).status
		).toBe(200);
		expect((await call('eve', 'POST', '/workspace/leave', undefined, api(), shown)).status).toBe(
			204
		);

		expect(await events()).toEqual([
			['invite_sent', 'eve', null],
			['invite_resent', 'eve', null],
			['invite_accepted', 'fay', 'fay'],
			['invite_sent', 'eve', null],
			['invite_cancelled', 'eve', null],
			['invite_sent', 'eve', null],
			['invite_accepted', 'gus', 'gus'],
			['member_removed', 'eve', 'gus'],
			['transfer_offered', 'eve', 'fay'],
			['transfer_withdrawn', 'eve', 'fay'],
			['transfer_offered', 'eve', 'fay'],
			['transfer_declined', 'fay', 'fay'],
			['transfer_offered', 'eve', 'fay'],
			['owner_changed', 'fay', 'eve'],
			['member_left', 'eve', 'eve']
		]);
		const listed = await listMemberEvents(identity(), 'ws-log', 200);
		// The invite events name the invite; the readers get each person's current address.
		expect(listed.filter((event) => event.inviteId !== null)).toHaveLength(7);
		expect(listed.find((event) => event.action === 'owner_changed')).toMatchObject({
			actorEmail: 'fay@example.com',
			subjectEmail: 'eve@example.com'
		});
		const stored = await identity()
			.prepare("SELECT * FROM tenant_member_events WHERE tenant_id = 'ws-log'")
			.all<Record<string, unknown>>();
		const tokens = sent.flatMap((email) =>
			[...email.text.matchAll(/#([A-Za-z0-9_-]+)/g)].map((match) => match[1])
		);
		for (const row of stored.results)
			for (const value of Object.values(row)) {
				expect(String(value)).not.toContain('@');
				expect(tokens).not.toContain(String(value));
			}
	});

	it('records a member’s account deletion in each workspace they leave', async () => {
		expect((await invite('fay', 'hal@example.com')).status).toBe(201);
		expect((await accept('hal', lastToken())).status).toBe(200);
		expect(await deleteMemberOnlyUser(identity(), 'hal', clock)).toBe(true);
		const [latest] = await listMemberEvents(identity(), 'ws-log', 1);
		expect(latest).toMatchObject({
			action: 'account_deleted',
			actorUserId: 'hal',
			actorEmail: null,
			subjectUserId: 'hal'
		});
	});

	it('records no join for a person who is already a member', async () => {
		await addUser('jo');
		expect((await invite('fay', 'jo@example.com')).status).toBe(201);
		await identity()
			.prepare(
				"INSERT INTO tenant_memberships (tenant_id, user_id, role, created_at) VALUES ('ws-log', 'jo', 'member', 1)"
			)
			.run();
		const before = (await listMemberEvents(identity(), 'ws-log', 200)).length;
		expect((await accept('jo', lastToken())).status).toBe(404);
		expect(await listMemberEvents(identity(), 'ws-log', 200)).toHaveLength(before);
	});

	it('records the account deletion of an owner who is a member elsewhere', async () => {
		await addUser('ivy');
		await addWorkspace('ws-ivy', 'Ivy', 'ivy', 2);
		expect((await invite('fay', 'ivy@example.com')).status).toBe(201);
		expect((await accept('ivy', lastToken())).status).toBe(200);
		expect(
			await createAccountDeletion(identity(), {
				userId: 'ivy',
				workspaces: [{ tenantId: 'ws-ivy', analyticsShardId: 'analytics-1' }],
				contactEmail: null,
				now: clock
			})
		).toBe(true);
		const [latest] = await listMemberEvents(identity(), 'ws-log', 1);
		expect(latest).toMatchObject({ action: 'account_deleted', actorUserId: 'ivy' });
		expect((await listMemberEvents(identity(), 'ws-ivy', 10)).length).toBe(0);
	});

	it('keeps events for 90 days', async () => {
		const kept = (await listMemberEvents(identity(), 'ws-log', 200)).length;
		await deleteExpiredMemberEvents(identity(), clock + memberEventLifetimeMs, 1000);
		expect(await listMemberEvents(identity(), 'ws-log', 200)).toHaveLength(kept);
		await deleteExpiredMemberEvents(identity(), clock + memberEventLifetimeMs + 1, 1000);
		expect(await listMemberEvents(identity(), 'ws-log', 200)).toHaveLength(0);
	});
});

describe('member links migration', () => {
	it('keeps every invite and member event, in order, and allows invites without an address', async () => {
		const db = env.MEMBER_LINKS_MIGRATION_IDENTITY;
		const migrations = env.IDENTITY_MIGRATIONS;
		const index = migrations.findIndex((item) => item.name.startsWith('0017_'));
		expect(index).toBeGreaterThan(0);
		await applyD1Migrations(db, migrations.slice(0, index), 'flared_core_migrations');
		await db.batch([
			db.prepare("INSERT INTO installation (id, mode, created_at) VALUES (1, 'multi', 0)"),
			db.prepare(
				"INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('kim', '', 'kim@example.com', 1, 0, 0)"
			),
			db.prepare(
				"INSERT INTO tenants (id, name, analytics_shard_id, created_at, activated_at) VALUES ('t-kim', 'Kim', 'analytics-1', 1, 2)"
			),
			db.prepare(
				"INSERT INTO tenant_invites (id, tenant_id, email, token_hash, invited_by, created_at, expires_at) VALUES ('inv-1', 't-kim', 'lee@example.com', 'hash-1', 'kim', 5, 6)"
			),
			// Same time, so only the write order (rowid) orders them; the IDs sort the other way.
			db.prepare(
				"INSERT INTO tenant_member_events (id, tenant_id, action, actor_user_id, subject_user_id, invite_id, created_at) VALUES ('z', 't-kim', 'invite_sent', 'kim', NULL, 'inv-1', 7), ('a', 't-kim', 'invite_resent', 'kim', NULL, 'inv-1', 7)"
			)
		]);
		await expect(
			db
				.prepare(
					"INSERT INTO tenant_invites (id, tenant_id, email, token_hash, created_at, expires_at) VALUES ('inv-2', 't-kim', NULL, 'hash-2', 8, 9)"
				)
				.run()
		).rejects.toThrow();

		await applyD1Migrations(db, migrations, 'flared_core_migrations');
		expect(
			(await db.prepare('SELECT id, email, token_hash, invited_by FROM tenant_invites').all())
				.results
		).toEqual([{ id: 'inv-1', email: 'lee@example.com', token_hash: 'hash-1', invited_by: 'kim' }]);
		expect((await listMemberEvents(db, 't-kim', 10)).map((event) => event.id)).toEqual(['a', 'z']);
		// Several invites without an address, and an address still once per workspace.
		const invite = (id: string, email: string | null) =>
			db
				.prepare(
					"INSERT INTO tenant_invites (id, tenant_id, email, token_hash, created_at, expires_at) VALUES (?, 't-kim', ?, ?, 8, 9)"
				)
				.bind(id, email, `hash-${id}`)
				.run();
		await invite('inv-2', null);
		await invite('inv-3', null);
		await expect(invite('inv-4', 'lee@example.com')).rejects.toThrow();
		await db
			.prepare(
				"INSERT INTO tenant_member_events (id, tenant_id, action, actor_user_id, created_at) VALUES ('r', 't-kim', 'password_reset_issued', 'kim', 9)"
			)
			.run();
	});
});
