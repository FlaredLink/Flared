// SPDX-License-Identifier: AGPL-3.0-only
// Clients that the operator registers for the REST API, such as an automation platform or a
// desktop app. A confidential client gets a client secret; a public client (auth method none)
// gets none, so it can live in an app that cannot keep a secret, and PKCE proves each of its
// authorizations. Each is linked to the REST API resource only. Open registration and client
// metadata documents never link a client to that resource.
import type { D1Database } from '@cloudflare/workers-types/index.ts';
import { claimOperatorClient } from '@flared/data/oauth';
import { createOAuthServer, type OAuthServerConfig } from './provider';

export const operatorClientAuthMethods = [
	'client_secret_post',
	'client_secret_basic',
	'none'
] as const;
export type OperatorClientAuthMethod = (typeof operatorClientAuthMethods)[number];

export interface OperatorClientInput {
	name: string;
	redirectUri: string;
	authMethod: OperatorClientAuthMethod;
}

export class OperatorClientInputError extends Error {}

// The client ID and the secret. The secret is stored encrypted and is shown only here. A public
// client has none.
export interface RegisteredClient {
	clientId: string;
	clientSecret: string | null;
}

export function parseOperatorClientInput(value: unknown): OperatorClientInput {
	const input = (typeof value === 'object' && value !== null ? value : {}) as Record<
		string,
		unknown
	>;
	const name = typeof input.name === 'string' ? input.name.trim() : '';
	if (!name || name.length > 100)
		throw new OperatorClientInputError('Enter a name of 1 to 100 characters.');
	let redirect: URL;
	try {
		redirect = new URL(typeof input.redirectUri === 'string' ? input.redirectUri.trim() : '');
	} catch {
		throw new OperatorClientInputError('Enter the redirect URL.');
	}
	if (redirect.protocol !== 'https:' || redirect.hash || redirect.username || redirect.password)
		throw new OperatorClientInputError('The redirect URL must use HTTPS, with no fragment.');
	const authMethod = operatorClientAuthMethods.find((method) => method === input.authMethod);
	if (!authMethod) throw new OperatorClientInputError('Choose how the client sends its secret.');
	return { name, redirectUri: redirect.href, authMethod };
}

// Registers the client through the provider's own registration, so its record and encrypted
// secret are in the provider's format, then links it to the REST API resource alone.
export async function registerOperatorClient(
	db: D1Database,
	config: OAuthServerConfig,
	input: OperatorClientInput,
	now: number = Date.now()
): Promise<RegisteredClient> {
	if (!config.apiResource) throw new Error('No REST API resource is configured');
	const response = await createOAuthServer(db, config).handler(
		new Request(`${config.origin}/oauth2/register`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', accept: 'application/json' },
			body: JSON.stringify({
				client_name: input.name,
				redirect_uris: [input.redirectUri],
				token_endpoint_auth_method: input.authMethod,
				grant_types: ['authorization_code', 'refresh_token'],
				response_types: ['code']
			})
		})
	);
	if (response.status !== 200 && response.status !== 201)
		throw new Error('Client registration failed');
	const body = (await response.json()) as Record<string, unknown>;
	if (typeof body.client_id !== 'string') throw new Error('Client registration returned no ID');
	const clientSecret = typeof body.client_secret === 'string' ? body.client_secret : null;
	if ((clientSecret === null) !== (input.authMethod === 'none'))
		throw new Error('Client registration returned the wrong kind of client');
	await claimOperatorClient(db, body.client_id, config.apiResource, now);
	return { clientId: body.client_id, clientSecret };
}
