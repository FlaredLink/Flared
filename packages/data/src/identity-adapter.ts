// SPDX-License-Identifier: AGPL-3.0-only
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { drizzle } from 'drizzle-orm/d1';
import { identitySchema } from './identity';
export function createIdentityAdapter(db: D1Database): ReturnType<typeof drizzleAdapter> {
	return drizzleAdapter(drizzle(db, { schema: identitySchema }), {
		provider: 'sqlite',
		schema: identitySchema,
		transaction: false
	});
}
