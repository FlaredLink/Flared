// SPDX-License-Identifier: AGPL-3.0-only
// Makes another of the person's workspaces the active one for this sign-in.
export async function selectWorkspace(apiBase: string, tenantId: string): Promise<boolean> {
	try {
		const response = await fetch(`${apiBase}/workspaces/active`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ tenantId })
		});
		return response.status === 204;
	} catch {
		return false;
	}
}
