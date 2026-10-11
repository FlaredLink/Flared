// SPDX-License-Identifier: AGPL-3.0-only
// Invites by email: single use, bound to one address, within the member limit, and ended by
// expiry, cancellation, or a resend.
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { deleteIdentityRecords, deleteMemberOnlyUser } from '../packages/data/src/deletions';
import { createTenant, type PolicyLimits } from '../packages/data/src/tenancy';
import { createApi } from '../packages/server/src/api';
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

function api(emailsPerDay?: number) {
	return createApi({
		identity: identity(),
		routing: env.MEMBERS_ROUTING,
		analytics: { 'analytics-1': env.MEMBERS_ANALYTICS },
		appOrigin: origin,
		now: () => clock,
		invites: {
			email: {
				async send(message) {
					if (failEmail) throw new Error('No email');
					sent.push(message);
				}
			},
			inviteUrl: (token) => `${origin}/app/invite#${token}`,
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
				signedInAt: new Date().toISOString()
			};
		}
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
		expect(await deleteMemberOnlyUser(identity(), 'own')).toBe(false);
		expect(await rows("user WHERE id = 'own'")).toBe(1);
		expect(await rows("tenant_memberships WHERE user_id = 'oli'")).toBe(1);
		expect(await deleteMemberOnlyUser(identity(), 'oli')).toBe(true);
		expect(await rows("user WHERE id = 'oli'")).toBe(0);
		expect(await rows("tenant_memberships WHERE user_id = 'oli'")).toBe(0);
		expect(await rows('"session" WHERE "userId" = \'oli\'')).toBe(0);
		expect(await rows("tenant_memberships WHERE tenant_id = 'ws-team'")).toBe(1);
	});
});
