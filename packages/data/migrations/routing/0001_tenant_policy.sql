-- SPDX-License-Identifier: AGPL-3.0-only
-- Projection of the identity policy fields that link management and redirects need.
CREATE TABLE tenant_policy (
 tenant_id TEXT PRIMARY KEY NOT NULL,
 revision INTEGER NOT NULL CHECK (revision >= 1),
 analytics_shard_id TEXT NOT NULL,
 active_link_limit INTEGER NOT NULL CHECK (active_link_limit >= 0),
 domain_limit INTEGER NOT NULL CHECK (domain_limit >= 0),
 updated_at INTEGER NOT NULL
);
