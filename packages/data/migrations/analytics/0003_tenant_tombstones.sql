-- SPDX-License-Identifier: AGPL-3.0-only
-- A deleted tenant's marker on its shard. A late click for it is dropped instead of retried.
-- Rows expire after 90 days, longer than the 48-hour replay horizon.
CREATE TABLE tenant_tombstones (
 tenant_id TEXT PRIMARY KEY NOT NULL,
 deleted_at INTEGER NOT NULL
);
CREATE INDEX tenant_tombstones_deleted ON tenant_tombstones(deleted_at);
