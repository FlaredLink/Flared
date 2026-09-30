// SPDX-License-Identifier: AGPL-3.0-only
// Matches getAuthTables from Better Auth 1.7.6 with emailOTP + magicLink.
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
export const identitySchema = { user, session, account, verification };
