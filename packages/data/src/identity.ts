// SPDX-License-Identifier: AGPL-3.0-only
// Matches getAuthTables from Better Auth 1.7.7 with emailOTP, magicLink, passkey, and apiKey.
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
export const identitySchema = { user, session, account, verification, passkey, apikey };
