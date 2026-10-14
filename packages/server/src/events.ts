// SPDX-License-Identifier: AGPL-3.0-only
// Product events that an edition may record for its own analytics. The core reports them through
// this hook and records nothing itself; without a hook, as in the standalone edition, nothing is
// sent anywhere.
import type { ApiPrincipal } from './api';

// Where a link was created: the dashboard, the CLI, another API client, or an assistant over MCP.
export type LinkChannel = 'web' | 'cli' | 'api' | 'mcp';

export type ProductEvent =
	| { type: 'link_created'; userId: string; tenantId: string; channel: LinkChannel }
	| {
			type: 'limit_reached';
			userId: string;
			tenantId: string;
			limit: 'links' | 'members' | 'domains';
	  }
	| { type: 'mcp_tool_called'; userId: string; tenantId: string; clientId: string; tool: string }
	| {
			type: 'assistant_connected';
			userId: string;
			tenantId: string;
			clientId: string;
			// The name the app declared at registration.
			clientName: string;
	  };

export interface ProductEvents {
	record(event: ProductEvent): Promise<void>;
}

// An event never fails or delays the action that produced it beyond the hook's own call.
export async function recordProductEvent(
	events: ProductEvents | undefined,
	event: ProductEvent
): Promise<void> {
	if (!events) return;
	try {
		await events.record(event);
	} catch {
		console.error(JSON.stringify({ event: 'product_event_failed', type: event.type }));
	}
}

// The CLI names itself in its user agent (packages/cli). Any other token is an API client.
export function linkChannel(principal: ApiPrincipal, userAgent: string | null): LinkChannel {
	if (principal.kind === 'session') return 'web';
	if (principal.kind === 'oauth') return 'mcp';
	return userAgent?.startsWith('flared-cli/') ? 'cli' : 'api';
}
