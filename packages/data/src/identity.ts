// SPDX-License-Identifier: AGPL-3.0-only
// Matches getAuthTables from Better Auth 1.7.7 with emailOTP, magicLink, passkey, apiKey, and the
// OAuth provider with MCP and CIMD. Array and JSON fields are stored as JSON text.
import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
const time = (name: string) => integer(name, { mode: 'timestamp_ms' });
export const user = sqliteTable('user', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	email: text('email').notNull().unique(),
	emailVerified: integer('emailVerified', { mode: 'boolean' }).notNull().default(false),
	image: text('image'),
	createdAt: time('createdAt').notNull(),
	updatedAt: time('updatedAt').notNull()
});
export const session = sqliteTable(
	'session',
	{
		id: text('id').primaryKey(),
		expiresAt: time('expiresAt').notNull(),
		token: text('token').notNull().unique(),
		createdAt: time('createdAt').notNull(),
		updatedAt: time('updatedAt').notNull(),
		ipAddress: text('ipAddress'),
		userAgent: text('userAgent'),
		userId: text('userId')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' })
	},
	(table) => [index('session_userId_idx').on(table.userId)]
);
export const account = sqliteTable(
	'account',
	{
		id: text('id').primaryKey(),
		accountId: text('accountId').notNull(),
		providerId: text('providerId').notNull(),
		userId: text('userId')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		accessToken: text('accessToken'),
		refreshToken: text('refreshToken'),
		idToken: text('idToken'),
		accessTokenExpiresAt: time('accessTokenExpiresAt'),
		refreshTokenExpiresAt: time('refreshTokenExpiresAt'),
		scope: text('scope'),
		password: text('password'),
		createdAt: time('createdAt').notNull(),
		updatedAt: time('updatedAt').notNull()
	},
	(table) => [index('account_userId_idx').on(table.userId)]
);
export const verification = sqliteTable(
	'verification',
	{
		id: text('id').primaryKey(),
		identifier: text('identifier').notNull().unique(),
		value: text('value').notNull(),
		expiresAt: time('expiresAt').notNull(),
		createdAt: time('createdAt').notNull(),
		updatedAt: time('updatedAt').notNull(),
		consumed: integer('consumed', { mode: 'boolean' }).notNull().default(false)
	},
	(table) => [index('verification_identifier_idx').on(table.identifier)]
);
export const passkey = sqliteTable(
	'passkey',
	{
		id: text('id').primaryKey(),
		name: text('name'),
		publicKey: text('publicKey').notNull(),
		userId: text('userId')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		credentialID: text('credentialID').notNull().unique(),
		counter: integer('counter').notNull(),
		deviceType: text('deviceType').notNull(),
		backedUp: integer('backedUp', { mode: 'boolean' }).notNull(),
		transports: text('transports'),
		createdAt: time('createdAt'),
		aaguid: text('aaguid')
	},
	(table) => [index('passkey_userId_idx').on(table.userId)]
);
export const apikey = sqliteTable(
	'apikey',
	{
		id: text('id').primaryKey(),
		configId: text('configId').notNull().default('default'),
		name: text('name'),
		start: text('start'),
		referenceId: text('referenceId')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		prefix: text('prefix'),
		key: text('key').notNull().unique(),
		refillInterval: integer('refillInterval'),
		refillAmount: integer('refillAmount'),
		lastRefillAt: time('lastRefillAt'),
		enabled: integer('enabled', { mode: 'boolean' }).default(true),
		rateLimitEnabled: integer('rateLimitEnabled', { mode: 'boolean' }).default(true),
		rateLimitTimeWindow: integer('rateLimitTimeWindow').default(86400000),
		rateLimitMax: integer('rateLimitMax').default(10),
		requestCount: integer('requestCount').default(0),
		remaining: integer('remaining'),
		lastRequest: time('lastRequest'),
		expiresAt: time('expiresAt'),
		createdAt: time('createdAt').notNull(),
		updatedAt: time('updatedAt').notNull(),
		permissions: text('permissions'),
		metadata: text('metadata')
	},
	(table) => [
		index('apikey_configId_idx').on(table.configId),
		index('apikey_referenceId_idx').on(table.referenceId)
	]
);
const bool = (name: string) => integer(name, { mode: 'boolean' });
export const oauthClient = sqliteTable(
	'oauthClient',
	{
		id: text('id').primaryKey(),
		clientId: text('clientId').notNull().unique(),
		clientSecret: text('clientSecret'),
		clientDiscoveryId: text('clientDiscoveryId'),
		disabled: bool('disabled').default(false),
		skipConsent: bool('skipConsent'),
		enableEndSession: bool('enableEndSession'),
		subjectType: text('subjectType'),
		scopes: text('scopes'),
		clientCredentialsScopes: text('clientCredentialsScopes'),
		userId: text('userId').references(() => user.id, { onDelete: 'cascade' }),
		createdAt: time('createdAt'),
		updatedAt: time('updatedAt'),
		name: text('name'),
		uri: text('uri'),
		icon: text('icon'),
		contacts: text('contacts'),
		tos: text('tos'),
		policy: text('policy'),
		softwareId: text('softwareId'),
		softwareVersion: text('softwareVersion'),
		softwareStatement: text('softwareStatement'),
		redirectUris: text('redirectUris').notNull(),
		postLogoutRedirectUris: text('postLogoutRedirectUris'),
		backchannelLogoutUri: text('backchannelLogoutUri'),
		backchannelLogoutSessionRequired: bool('backchannelLogoutSessionRequired'),
		tokenEndpointAuthMethod: text('tokenEndpointAuthMethod'),
		applicationType: text('applicationType'),
		jwks: text('jwks'),
		jwksUri: text('jwksUri'),
		grantTypes: text('grantTypes'),
		responseTypes: text('responseTypes'),
		requirePKCE: bool('requirePKCE'),
		dpopBoundAccessTokens: bool('dpopBoundAccessTokens').default(false),
		referenceId: text('referenceId'),
		metadata: text('metadata')
	},
	(table) => [index('oauthClient_userId_idx').on(table.userId)]
);
export const oauthResource = sqliteTable('oauthResource', {
	id: text('id').primaryKey(),
	identifier: text('identifier').notNull().unique(),
	name: text('name').notNull(),
	accessTokenTtl: integer('accessTokenTtl'),
	refreshTokenTtl: integer('refreshTokenTtl'),
	signingAlgorithm: text('signingAlgorithm'),
	signingKeyId: text('signingKeyId'),
	allowedScopes: text('allowedScopes'),
	customClaims: text('customClaims'),
	dpopBoundAccessTokensRequired: bool('dpopBoundAccessTokensRequired').default(false),
	disabled: bool('disabled').default(false),
	createdAt: time('createdAt'),
	updatedAt: time('updatedAt'),
	policyVersion: integer('policyVersion').default(1),
	metadata: text('metadata')
});
export const oauthClientResource = sqliteTable(
	'oauthClientResource',
	{
		id: text('id').primaryKey(),
		clientId: text('clientId')
			.notNull()
			.references(() => oauthClient.clientId, { onDelete: 'cascade' }),
		resourceId: text('resourceId')
			.notNull()
			.references(() => oauthResource.identifier, { onDelete: 'cascade' }),
		metadata: text('metadata'),
		createdAt: time('createdAt')
	},
	(table) => [
		index('oauthClientResource_clientId_idx').on(table.clientId),
		index('oauthClientResource_resourceId_idx').on(table.resourceId)
	]
);
// Columns shared by access and refresh tokens.
const grantColumns = () => ({
	id: text('id').primaryKey(),
	clientId: text('clientId')
		.notNull()
		.references(() => oauthClient.clientId, { onDelete: 'cascade' }),
	sessionId: text('sessionId').references(() => session.id, { onDelete: 'set null' }),
	referenceId: text('referenceId'),
	authorizationCodeId: text('authorizationCodeId'),
	resources: text('resources'),
	requestedUserInfoClaims: text('requestedUserInfoClaims'),
	expiresAt: time('expiresAt'),
	createdAt: time('createdAt'),
	revoked: time('revoked'),
	confirmation: text('confirmation'),
	scopes: text('scopes').notNull()
});
export const oauthRefreshToken = sqliteTable(
	'oauthRefreshToken',
	{
		...grantColumns(),
		token: text('token').notNull().unique(),
		userId: text('userId')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		rotatedAt: time('rotatedAt'),
		rotationReplayResponse: text('rotationReplayResponse'),
		rotationReplayExpiresAt: time('rotationReplayExpiresAt'),
		authTime: time('authTime')
	},
	(table) => [
		index('oauthRefreshToken_clientId_idx').on(table.clientId),
		index('oauthRefreshToken_userId_idx').on(table.userId)
	]
);
export const oauthAccessToken = sqliteTable(
	'oauthAccessToken',
	{
		...grantColumns(),
		token: text('token').unique(),
		userId: text('userId').references(() => user.id, { onDelete: 'cascade' }),
		refreshId: text('refreshId').references(() => oauthRefreshToken.id, { onDelete: 'cascade' })
	},
	(table) => [
		index('oauthAccessToken_clientId_idx').on(table.clientId),
		index('oauthAccessToken_userId_idx').on(table.userId)
	]
);
export const oauthConsent = sqliteTable(
	'oauthConsent',
	{
		id: text('id').primaryKey(),
		clientId: text('clientId')
			.notNull()
			.references(() => oauthClient.clientId, { onDelete: 'cascade' }),
		userId: text('userId').references(() => user.id, { onDelete: 'cascade' }),
		referenceId: text('referenceId'),
		resources: text('resources'),
		requestedUserInfoClaims: text('requestedUserInfoClaims'),
		scopes: text('scopes').notNull(),
		createdAt: time('createdAt'),
		updatedAt: time('updatedAt')
	},
	(table) => [
		index('oauthConsent_clientId_idx').on(table.clientId),
		index('oauthConsent_userId_idx').on(table.userId)
	]
);
export const oauthClientAssertion = sqliteTable('oauthClientAssertion', {
	id: text('id').primaryKey(),
	expiresAt: time('expiresAt').notNull()
});
export const identitySchema = {
	user,
	session,
	account,
	verification,
	passkey,
	apikey,
	oauthClient,
	oauthResource,
	oauthClientResource,
	oauthRefreshToken,
	oauthAccessToken,
	oauthConsent,
	oauthClientAssertion
};
