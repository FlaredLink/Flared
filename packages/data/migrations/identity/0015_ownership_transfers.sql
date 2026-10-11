-- SPDX-License-Identifier: AGPL-3.0-only
-- The owner offers the workspace to a member, who accepts it. One open offer per workspace: a new
-- offer replaces the old one. An offer only counts while its sender still owns the workspace and
-- its receiver is still a member, so a stale row grants nothing.
CREATE TABLE tenant_transfers (
 tenant_id TEXT PRIMARY KEY NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 from_user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
 to_user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL
);
CREATE INDEX tenant_transfers_to_user ON tenant_transfers(to_user_id);
