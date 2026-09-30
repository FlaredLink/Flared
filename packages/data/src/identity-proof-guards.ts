// SPDX-License-Identifier: AGPL-3.0-only
import { AsyncLocalStorage } from 'node:async_hooks';
import { APIError, type AuthContext, type Verification } from 'better-auth';

type ProofMode = 'issue' | 'verify';
interface ProofScope {
	mode: ProofMode;
	observed: Map<string, Verification>;
	claimed: Map<string, Verification>;
}
const scopes = new AsyncLocalStorage<ProofScope>();
/** Only sign-in OTP and magic-link server methods may run in this scope. */
export function withIdentityProofScope<T>(
	mode: ProofMode,
	operation: () => Promise<T>
): Promise<T> {
	return scopes.run({ mode, observed: new Map(), claimed: new Map() }, operation);
}
function scope(): ProofScope {
	const current = scopes.getStore();
	if (!current) throw new Error('Identity proof operation requires an explicit scope');
	return current;
}
interface StoredProof {
	id: string;
	identifier: string;
	value: string;
	expiresAt: number;
	createdAt: number;
	updatedAt: number;
}
function hydrate(row: StoredProof): Verification {
	return {
		...row,
		expiresAt: new Date(row.expiresAt),
		createdAt: new Date(row.createdAt),
		updatedAt: new Date(row.updatedAt)
	};
}
const columns = 'id, identifier, value, expiresAt, createdAt, updatedAt';
// The bound clock makes controlled-clock tests possible. SQLite's clock also
// enforces expiry if execution occurs later than the bound JS timestamp.
const live = "expiresAt > MAX(?, CAST(unixepoch('subsec') * 1000 AS INTEGER))";
function nextAttempt(previous: string, replacement: string): boolean {
	const delimiter = previous.lastIndexOf(':');
	if (delimiter < 0) return false;
	const count = Number(previous.slice(delimiter + 1));
	return (
		Number.isSafeInteger(count) &&
		count >= 0 &&
		replacement === `${previous.slice(0, delimiter)}:${count + 1}`
	);
}
/**
 * Storage correction for Better Auth 1.7.6 sign-in OTP / magic-link plugins.
 * Install only after awaited $context, before exposing the six-route facade.
 * Requires the fixed shared schema, plain identifiers, D1, and no verification
 * hooks/secondary storage. The composer must construct the trusted pinned
 * plugins directly: plugin-supplied hooks cannot be introspected here. Unsupported endpoints must never call this adapter.
 * Hashing, proof comparison, attempt policy and sessions stay in Better Auth.
 */
export function installD1ProofGuards(
	context: Pick<AuthContext, 'options' | 'internalAdapter' | 'generateId' | 'secondaryStorage'>,
	db: D1Database
): void {
	const options = context.options;
	if (
		context.secondaryStorage ||
		(options.verification?.storeIdentifier && options.verification.storeIdentifier !== 'plain') ||
		options.databaseHooks?.verification ||
		options.verification?.modelName ||
		options.verification?.fields ||
		options.plugins?.some((plugin) => plugin.id !== 'email-otp' && plugin.id !== 'magic-link')
	) {
		throw new Error('Unsupported verification configuration for D1 proof guards');
	}
	const adapter = context.internalAdapter;
	adapter.findVerificationValue = async (identifier) => {
		const current = scope();
		const row = await db
			.prepare(`SELECT ${columns} FROM verification WHERE identifier = ? AND consumed = 0 LIMIT 1`)
			.bind(identifier)
			.first<StoredProof>();
		if (!row) return null;
		const proof = hydrate(row);
		current.observed.set(identifier, proof);
		return proof;
	};
	adapter.consumeVerificationValue = async (identifier) => {
		const current = scope();
		if (current.mode !== 'verify') throw new Error('Cannot consume in issuance scope');
		const row = await db
			.prepare(
				`UPDATE verification SET consumed = 1 WHERE identifier = ? AND consumed = 0 AND ${live} RETURNING ${columns}`
			)
			.bind(identifier, Date.now())
			.first<StoredProof>();
		if (!row) return null;
		const proof = hydrate(row);
		current.claimed.set(identifier, proof);
		return proof;
	};
	adapter.createVerificationValue = async (data) => {
		const current = scope();
		const now = Date.now();
		if (current.mode === 'issue') {
			const id = crypto.randomUUID();
			const row = await db
				.prepare(
					`INSERT INTO verification (id, identifier, value, expiresAt, createdAt, updatedAt, consumed)
        VALUES (?, ?, ?, ?, ?, ?, 0) ON CONFLICT(identifier) DO UPDATE SET
        id = excluded.id, value = excluded.value, expiresAt = excluded.expiresAt,
        createdAt = excluded.createdAt, updatedAt = excluded.updatedAt, consumed = 0 RETURNING ${columns}`
				)
				.bind(id, data.identifier, data.value, data.expiresAt.getTime(), now, now)
				.first<StoredProof>();
			if (!row) throw new Error('Proof issuance did not persist');
			return hydrate(row);
		}
		const claimed = current.claimed.get(data.identifier);
		if (
			!claimed ||
			claimed.expiresAt.getTime() !== data.expiresAt.getTime() ||
			!nextAttempt(claimed.value, data.value)
		) {
			throw new Error('Proof restoration does not match the claimed generation');
		}
		// Consume the right to restore before awaiting SQL. Reusing the scope cannot
		// restore again or overwrite another attempt's incremented failure budget.
		current.claimed.delete(data.identifier);
		const row = await db
			.prepare(
				`UPDATE verification SET value = ?, updatedAt = ?, consumed = 0
      WHERE id = ? AND identifier = ? AND consumed = 1 AND value = ? AND ${live} RETURNING ${columns}`
			)
			.bind(data.value, now, claimed.id, claimed.identifier, claimed.value, now)
			.first<StoredProof>();
		if (!row)
			throw APIError.fromStatus('BAD_REQUEST', {
				code: 'INVALID_CHALLENGE',
				message: 'Invalid or expired proof'
			});
		return hydrate(row);
	};
	adapter.deleteVerificationByIdentifier = async (identifier) => {
		const current = scope();
		const observed = current.observed.get(identifier);
		if (current.mode !== 'verify' || !observed) throw new Error('Unsupported proof deletion');
		await db
			.prepare(
				"DELETE FROM verification WHERE id = ? AND identifier = ? AND expiresAt <= MAX(?, CAST(unixepoch('subsec') * 1000 AS INTEGER))"
			)
			.bind(observed.id, identifier, Date.now())
			.run();
		current.observed.delete(identifier);
	};
}
