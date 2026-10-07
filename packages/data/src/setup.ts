// SPDX-License-Identifier: AGPL-3.0-only
// Identity-store records of standalone setup (migration 0011). The claim fixes every value
// when it is created. Each step advances in the same batch as its records, so two requests
// that resume one claim cannot run a step twice.
import type { D1Database } from '@cloudflare/workers-types/index.ts';
import { tenantStatements, type NewTenant } from './tenancy';

// unclaimed: no owner yet. initializing: claimed, steps remain. active: the owner exists.
// closed: the workspace was deleted; the installation never opens again. misconfigured: the
// identity store belongs to a multi-workspace installation or has no setup record.
export type SetupState = 'unclaimed' | 'initializing' | 'active' | 'closed' | 'misconfigured';

// 0 claimed, 1 owner account, 2 workspace, 3 app host domain, 4 policy projected.
export type SetupStep = 0 | 1 | 2 | 3 | 4;

export interface SetupClaim {
	claimId: string;
	userId: string;
	tenantId: string;
	// As typed; the account stores it in lower case.
	username: string;
	workspaceName: string;
	// Kept until activation, then null.
	passwordHash: string | null;
	step: SetupStep;
	appOrigin: string;
	state: 'initializing' | 'active';
}

function step(value: unknown): SetupStep {
	if (value === 0 || value === 1 || value === 2 || value === 3 || value === 4) return value;
	throw new Error('Invalid stored setup step');
}

function text(value: unknown, field: string): string {
	if (typeof value !== 'string' || !value) throw new Error(`Invalid stored setup ${field}`);
	return value;
}

export async function readSetupState(db: D1Database): Promise<SetupState> {
	const row = await db
		.prepare(
			'SELECT i.mode, i.closed_at, s.state FROM (SELECT 1) LEFT JOIN installation i ON i.id = 1 LEFT JOIN installation_setup s ON s.id = 1'
		)
		.first<{ mode: unknown; closed_at: unknown; state: unknown }>();
	if (!row || row.mode === null) return 'unclaimed';
	if (row.mode !== 'single') return 'misconfigured';
	if (row.closed_at !== null) return 'closed';
	if (row.state === 'initializing' || row.state === 'active') return row.state;
	return 'misconfigured';
}

export async function readSetupClaim(db: D1Database): Promise<SetupClaim | null> {
	const row = await db
		.prepare(
			'SELECT claim_id, user_id, tenant_id, username, workspace_name, password_hash, step, app_origin, state FROM installation_setup WHERE id = 1'
		)
		.first<Record<string, unknown>>();
	if (!row) return null;
	const state = row.state;
	if (state !== 'initializing' && state !== 'active') throw new Error('Invalid stored setup state');
	const hash = row.password_hash;
	if (hash !== null && typeof hash !== 'string') throw new Error('Invalid stored setup hash');
	return {
		claimId: text(row.claim_id, 'claim'),
		userId: text(row.user_id, 'user'),
		tenantId: text(row.tenant_id, 'tenant'),
		username: text(row.username, 'username'),
		workspaceName: text(row.workspace_name, 'workspace name'),
		passwordHash: hash,
		step: step(row.step),
		appOrigin: text(row.app_origin, 'origin'),
		state
	};
}

// Creates the single installation and the claim in one batch. False when another claim or a
// multi-workspace installation already exists.
export async function claimSetup(
	db: D1Database,
	claim: Omit<SetupClaim, 'step' | 'state'>,
	now: number
): Promise<boolean> {
	try {
		await db.batch([
			db
				.prepare(
					"INSERT INTO installation (id, mode, fixed_tenant_id, created_at) VALUES (1, 'single', ?, ?)"
				)
				.bind(claim.tenantId, now),
			db
				.prepare(
					"INSERT INTO installation_setup (id, state, claim_id, user_id, tenant_id, username, workspace_name, password_hash, step, app_origin, started_at) VALUES (1, 'initializing', ?, ?, ?, ?, ?, ?, 0, ?, ?)"
				)
				.bind(
					claim.claimId,
					claim.userId,
					claim.tenantId,
					claim.username,
					claim.workspaceName,
					claim.passwordHash,
					claim.appOrigin,
					now
				)
		]);
		return true;
	} catch (error) {
		if ((await readSetupClaim(db)) !== null || (await readSetupState(db)) !== 'unclaimed')
			return false;
		throw error;
	}
}

function advance(db: D1Database, from: SetupStep): D1PreparedStatement {
	return db
		.prepare(
			"UPDATE installation_setup SET step = ? WHERE id = 1 AND state = 'initializing' AND step = ?"
		)
		.bind(from + 1, from);
}

// Step 1: the owner's user and password account, with the library's hash. The email is an
// internal address that is never verified.
export async function createOwnerRecords(
	db: D1Database,
	claim: SetupClaim,
	owner: { email: string; passwordHash: string },
	now: number
): Promise<void> {
	await db.batch([
		db
			.prepare(
				'INSERT INTO "user" (id, name, email, emailVerified, username, displayUsername, createdAt, updatedAt) VALUES (?, ?, ?, 0, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING'
			)
			.bind(
				claim.userId,
				claim.username,
				owner.email,
				claim.username.toLowerCase(),
				claim.username,
				now,
				now
			),
		db
			.prepare(
				"INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt) VALUES (?, ?, 'credential', ?, ?, ?, ?) ON CONFLICT(userId, providerId) DO NOTHING"
			)
			.bind(claim.claimId, claim.userId, claim.userId, owner.passwordHash, now, now),
		advance(db, 0)
	]);
}

// Step 2: the workspace with its owner membership and first policy. A second run fails on the
// tenant's primary key and changes nothing.
export async function createSetupTenant(db: D1Database, tenant: NewTenant): Promise<void> {
	await db.batch([...tenantStatements(db, tenant), advance(db, 1)]);
}

// Steps 3 and 4 change other stores first and then record the step here.
export async function advanceSetupStep(db: D1Database, from: 2 | 3): Promise<void> {
	await advance(db, from).run();
}

// Activates setup when the membership, the password account, and the workspace (both policy
// acknowledgements) exist, and clears the stored hash. Returns whether setup is active.
export async function activateSetup(db: D1Database, now: number): Promise<boolean> {
	await db.batch([
		db
			.prepare(
				`UPDATE installation_setup SET state = 'active', activated_at = ?, password_hash = NULL
 WHERE id = 1 AND state = 'initializing' AND step = 4
 AND EXISTS (SELECT 1 FROM tenant_memberships m WHERE m.tenant_id = installation_setup.tenant_id AND m.user_id = installation_setup.user_id AND m.role = 'owner')
 AND EXISTS (SELECT 1 FROM account a WHERE a.userId = installation_setup.user_id AND a.providerId = 'credential' AND a.password IS NOT NULL)
 AND EXISTS (SELECT 1 FROM tenants t WHERE t.id = installation_setup.tenant_id AND t.activated_at IS NOT NULL)`
			)
			.bind(now),
		db
			.prepare(
				"INSERT INTO owner_audit (id, action, created_at) SELECT ?, 'setup_activated', ? WHERE EXISTS (SELECT 1 FROM installation_setup WHERE id = 1 AND state = 'active') AND NOT EXISTS (SELECT 1 FROM owner_audit WHERE action = 'setup_activated')"
			)
			.bind(crypto.randomUUID(), now)
	]);
	return (await readSetupClaim(db))?.state === 'active';
}
