// SPDX-License-Identifier: AGPL-3.0-only
// The deployment maps each analytics shard ID to a statically bound D1 database. Every reader
// and writer resolves through this map; an unknown ID never falls back to another database.
import type { D1Database } from '@cloudflare/workers-types/index.ts';

export type AnalyticsShards = Readonly<Record<string, D1Database>>;

export class UnknownShardError extends Error {
	constructor() {
		super('Analytics shard is not bound');
	}
}

export function resolveShard(shards: AnalyticsShards, shardId: string): D1Database {
	const db = Object.hasOwn(shards, shardId) ? shards[shardId] : undefined;
	if (!db || typeof db.prepare !== 'function') throw new UnknownShardError();
	return db;
}
