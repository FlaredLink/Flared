// SPDX-License-Identifier: AGPL-3.0-only
// POST /api/setup: the standalone owner and workspace. The request proves the deployment's
// SETUP_SECRET; a visitor who only reaches the URL cannot claim the installation. The first
// proven request claims the installation with every value fixed; a retry with the secret and
// the same username and password resumes that claim. After activation setup never opens again,
// whether or not the secret is still configured.
import type { D1Database } from '@cloudflare/workers-types/index.ts';
import { ensurePlatformDomain } from '@flared/data/domains';
import {
	activateSetup,
	advanceSetupStep,
	claimSetup,
	createOwnerRecords,
	createSetupTenant,
	readSetupClaim,
	readSetupState,
	type SetupClaim,
	type SetupState
} from '@flared/data/setup';
import type { PolicyLimits } from '@flared/data/tenancy';
import { reserveAttempt } from './auth/attempts';
import { keyedHash } from './auth/limits';
import {
	createOwnerAuth,
	isNewPassword,
	ownerEmail,
	usernamePattern,
	type OwnerAuth,
	type OwnerAuthConfig
} from './auth/owner';
import { authenticated, authFailure, authJson, rateLimited, trustedSource } from './auth/routes';
import { AuthInputError, exactRecord, readAuthBody } from './auth/validation';
import type { AnalyticsShards } from './shards';
import { projectPolicy } from './tenancy';
import { finalizeAuthResponse } from './web/forward';

export { readSetupState, type SetupState };

export const minSetupSecretBytes = 32;
const maxWorkspaceName = 64;

export interface SetupOptions {
	identity: D1Database;
	routing: D1Database;
	analytics: AnalyticsShards;
	// The shard that holds the workspace's analytics.
	analyticsShardId: string;
	config: OwnerAuthConfig;
	// The deployment's setup secret, or null when it is not configured.
	setupSecret: string | null;
	// The workspace's first limits.
	limits: PolicyLimits;
	auth?: () => Promise<OwnerAuth>;
	now?: () => number;
}

interface SetupInput {
	secret: string;
	username: string;
	password: string;
	workspaceName: string;
}

function setupBody(value: unknown): SetupInput {
	const record = exactRecord(value, ['secret', 'username', 'password', 'workspaceName']);
	const { secret, username, password, workspaceName } = record;
	if (typeof secret !== 'string' || secret.length > 1024 || typeof username !== 'string')
		throw new AuthInputError(400, 'INVALID_REQUEST');
	if (typeof workspaceName !== 'string') throw new AuthInputError(400, 'INVALID_REQUEST');
	const name = workspaceName.trim();
	if (!usernamePattern.test(username.trim()) || !isNewPassword(password) || !name)
		throw new AuthInputError(400, 'INVALID_REQUEST');
	if (name.length > maxWorkspaceName || /[\u0000-\u001f\u007f]/.test(name))
		throw new AuthInputError(400, 'INVALID_REQUEST');
	return { secret, username: username.trim(), password, workspaceName: name };
}

// A setup secret that is configured, long enough, and not the auth secret.
export function usableSetupSecret(secret: string | null, authSecret: string): secret is string {
	return (
		secret !== null &&
		new TextEncoder().encode(secret).byteLength >= minSetupSecretBytes &&
		secret !== authSecret
	);
}

// Compares digests, so the comparison takes the same time for any length.
async function sameSecret(given: string, expected: string): Promise<boolean> {
	const encoder = new TextEncoder();
	const [a, b] = await Promise.all(
		[given, expected].map((value) => crypto.subtle.digest('SHA-256', encoder.encode(value)))
	);
	return crypto.subtle.timingSafeEqual(a, b);
}

function failure(code: string, status: number): Response {
	return finalizeAuthResponse(authFailure(code, status));
}

export async function handleSetup(request: Request, options: SetupOptions): Promise<Response> {
	const { identity, config } = options;
	const now = options.now ?? Date.now;
	const url = new URL(request.url);
	if (url.pathname !== '/api/setup') return failure('NOT_FOUND', 404);
	if (request.method !== 'POST')
		return finalizeAuthResponse(
			authJson({ error: { code: 'METHOD_NOT_ALLOWED' } }, 405, { allow: 'POST' })
		);
	let instance: Promise<OwnerAuth> | undefined;
	const getAuth = () => (instance ??= options.auth?.() ?? createOwnerAuth(identity, config));
	try {
		const input = setupBody(await readAuthBody(request, config.origin));
		const state = await readSetupState(identity);
		if (state === 'active' || state === 'closed') return failure('SETUP_CLOSED', 409);
		if (state === 'misconfigured') {
			console.error(JSON.stringify({ event: 'setup_identity_misconfigured' }));
			return failure('SETUP_UNAVAILABLE', 503);
		}
		if (!usableSetupSecret(options.setupSecret, config.secret)) {
			console.error(
				JSON.stringify({
					event: 'setup_secret_unusable',
					detail: `Set SETUP_SECRET to a random value of at least ${minSetupSecretBytes} bytes that differs from AUTH_SECRET.`
				})
			);
			return failure('SETUP_UNAVAILABLE', 503);
		}
		const source = trustedSource(request);
		if (!source) return failure('SETUP_UNAVAILABLE', 503);
		const budget = await reserveAttempt(
			identity,
			'setup',
			await keyedHash(config.rateLimitSecret, `setup:${source}`),
			now()
		);
		if (!budget.allowed) return finalizeAuthResponse(rateLimited(budget.retryAfter));
		if (!(await sameSecret(input.secret, options.setupSecret)))
			return failure('SETUP_SECRET_INVALID', 403);

		const context = await (await getAuth()).$context;
		let claim = await readSetupClaim(identity);
		if (!claim) {
			const passwordHash = await context.password.hash(input.password);
			await claimSetup(
				identity,
				{
					claimId: crypto.randomUUID(),
					userId: crypto.randomUUID(),
					tenantId: crypto.randomUUID(),
					username: input.username,
					workspaceName: input.workspaceName,
					passwordHash,
					appOrigin: config.origin
				},
				now()
			);
			claim = await readSetupClaim(identity);
			if (!claim) throw new Error('Setup claim missing');
		}
		// A resume must be the same owner; it never changes the claim.
		if (
			claim.state !== 'initializing' ||
			claim.passwordHash === null ||
			claim.username.toLowerCase() !== input.username.toLowerCase() ||
			!(await context.password.verify({ hash: claim.passwordHash, password: input.password }))
		)
			return failure(claim.state === 'active' ? 'SETUP_CLOSED' : 'SETUP_CLAIMED', 409);

		await runSteps(claim, claim.passwordHash, options, now);
		if (!(await activateSetup(identity, now()))) throw new Error('Setup did not activate');
		const result = await (
			await getAuth()
		).api
			.signInUsername({
				body: { username: claim.username, password: input.password },
				headers: new Headers({ origin: config.origin }),
				asResponse: true
			})
			.catch(() => null);
		return finalizeAuthResponse(
			result?.status === 200 ? authenticated(result) : authJson({ ok: true })
		);
	} catch (error) {
		if (error instanceof AuthInputError) return failure(error.code, error.status);
		console.error(JSON.stringify({ event: 'setup_step_failed' }));
		return failure('SETUP_UNAVAILABLE', 503);
	}
}

// Runs the remaining steps of the claim. A step that another request finished in parallel
// fails here or changes nothing; the stored step is read again before the next one.
async function runSteps(
	first: SetupClaim,
	passwordHash: string,
	options: SetupOptions,
	now: () => number
): Promise<void> {
	const { identity } = options;
	let claim: SetupClaim | null = first;
	while (claim && claim.state === 'initializing' && claim.step < 4) {
		const current: SetupClaim = claim;
		try {
			if (current.step === 0)
				await createOwnerRecords(
					identity,
					current,
					{ email: ownerEmail(current.userId), passwordHash },
					now()
				);
			else if (current.step === 1)
				await createSetupTenant(identity, {
					id: current.tenantId,
					name: current.workspaceName,
					ownerUserId: current.userId,
					analyticsShardId: options.analyticsShardId,
					limits: options.limits,
					now: now()
				});
			else if (current.step === 2) {
				await ensurePlatformDomain(options.routing, new URL(current.appOrigin).hostname, now());
				await advanceSetupStep(identity, 2);
			} else {
				await projectPolicy(
					identity,
					{ routing: options.routing, analytics: options.analytics },
					current.tenantId,
					now()
				);
				await advanceSetupStep(identity, 3);
			}
		} catch (error) {
			const stored = await readSetupClaim(identity);
			if (!stored || stored.step === current.step) throw error;
		}
		claim = await readSetupClaim(identity);
	}
}
