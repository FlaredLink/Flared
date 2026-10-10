// SPDX-License-Identifier: AGPL-3.0-only
// Abuse actions of the installation's operator: block a link, suspend a tenant, and end a
// tenant's credentials. They act across tenants, so only an operator composition may call them;
// tenant checks elsewhere stay as they are. The caller authenticates the operator and keeps the
// audit record.
import type { D1Database } from '@cloudflare/workers-types/index.ts';
import type { BlockReason } from '@flared/contracts/links';
import { setLinkBlock } from '@flared/data/links';
import { deleteTenantCredentials, setTenantSuspension } from '@flared/data/tenancy';
import { projectPolicy, type PolicyStores } from './tenancy';

// id identifies the operator's session in logs, never a secret.
export interface OperatorPrincipal {
	kind: 'operator';
	id: string;
}

// unchanged: the target was already in that state, so nothing was written.
export type OperatorResult =
	{ status: 'changed' | 'unchanged'; tenantId: string } | { status: 'not_found' };

function log(event: string, operator: OperatorPrincipal, fields: Record<string, string>): void {
	console.log(JSON.stringify({ event, operatorId: operator.id, ...fields }));
}

// A redirect snapshot lives at most 60 seconds, so the block reaches every visitor in that time.
export async function blockLink(
	routing: D1Database,
	operator: OperatorPrincipal,
	request: { linkId: string; reason: BlockReason; now: number }
): Promise<OperatorResult> {
	const result = await setLinkBlock(routing, request.linkId, {
		reason: request.reason,
		now: request.now
	});
	if (!result) return { status: 'not_found' };
	if (result.changed)
		log('operator_link_blocked', operator, { linkId: request.linkId, tenantId: result.tenantId });
	return { status: result.changed ? 'changed' : 'unchanged', tenantId: result.tenantId };
}

// The link opens again only if its owner still has it turned on.
export async function unblockLink(
	routing: D1Database,
	operator: OperatorPrincipal,
	request: { linkId: string }
): Promise<OperatorResult> {
	const result = await setLinkBlock(routing, request.linkId, null);
	if (!result) return { status: 'not_found' };
	if (result.changed)
		log('operator_link_unblocked', operator, { linkId: request.linkId, tenantId: result.tenantId });
	return { status: result.changed ? 'changed' : 'unchanged', tenantId: result.tenantId };
}

// projected false: the identity store holds the change, and retryProjections carries it to
// routing later. Redirects stop only after routing has it, so the caller shows that state.
export type SuspensionResult =
	| { status: 'changed' | 'unchanged'; tenantId: string; projected: boolean }
	| { status: 'not_found' };

async function changeSuspension(
	identity: D1Database,
	stores: PolicyStores,
	tenantId: string,
	suspension: { reason: BlockReason } | null,
	now: number
): Promise<SuspensionResult> {
	const result = await setTenantSuspension(identity, tenantId, suspension, now);
	if (!result) return { status: 'not_found' };
	// A repeated request also completes a projection that failed the first time.
	let projected = true;
	try {
		await projectPolicy(identity, stores, tenantId, now);
	} catch {
		projected = false;
		console.error(JSON.stringify({ event: 'policy_projection_deferred', tenantId }));
	}
	return { status: result.changed ? 'changed' : 'unchanged', tenantId, projected };
}

// Stops every link of the tenant. The API then refuses changes in the workspace.
export async function suspendTenant(
	identity: D1Database,
	stores: PolicyStores,
	operator: OperatorPrincipal,
	request: { tenantId: string; reason: BlockReason; now: number }
): Promise<SuspensionResult> {
	const result = await changeSuspension(
		identity,
		stores,
		request.tenantId,
		{ reason: request.reason },
		request.now
	);
	if (result.status === 'changed')
		log('operator_tenant_suspended', operator, { tenantId: request.tenantId });
	return result;
}

// Link blocks stay; each one is cleared on its own.
export async function reinstateTenant(
	identity: D1Database,
	stores: PolicyStores,
	operator: OperatorPrincipal,
	request: { tenantId: string; now: number }
): Promise<SuspensionResult> {
	const result = await changeSuspension(identity, stores, request.tenantId, null, request.now);
	if (result.status === 'changed')
		log('operator_tenant_reinstated', operator, { tenantId: request.tenantId });
	return result;
}

// Signs every member out and ends the workspace's API tokens and connected apps. The members can
// sign in again; a suspension decides what they can then do.
export async function revokeCustomerAccess(
	identity: D1Database,
	operator: OperatorPrincipal,
	request: { tenantId: string }
): Promise<void> {
	await deleteTenantCredentials(identity, request.tenantId);
	log('operator_access_revoked', operator, { tenantId: request.tenantId });
}
