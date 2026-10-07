-- SPDX-License-Identifier: AGPL-3.0-only
-- Hourly size samples of each analytics shard, for capacity checks. Rows expire after 90 days.
CREATE TABLE analytics_shard_samples (
 shard_id TEXT NOT NULL,
 sampled_at INTEGER NOT NULL,
 size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
 tenants INTEGER NOT NULL CHECK (tenants >= 0),
 PRIMARY KEY (shard_id, sampled_at)
) WITHOUT ROWID;

-- Click events that the Queue gave up on. id is "event:<eventId>" for a valid event and
-- "message:<messageId>" otherwise, so a redelivered dead letter is stored once. event holds the
-- minimized event JSON, or NULL when the body was invalid; nothing else of the body is kept.
-- Rows expire after 7 days.
CREATE TABLE dead_letters (
 id TEXT PRIMARY KEY NOT NULL,
 received_at INTEGER NOT NULL,
 shard_id TEXT,
 occurred_at INTEGER,
 event TEXT,
 requeued_at INTEGER
);
CREATE INDEX dead_letters_received ON dead_letters(received_at);
