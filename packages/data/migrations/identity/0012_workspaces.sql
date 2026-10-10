-- SPDX-License-Identifier: AGPL-3.0-only
-- A user may belong to several workspaces, and each sign-in session acts in one of them.

-- SQLite cannot change a CHECK constraint, so the membership table is rebuilt with the member
-- role. Each tenant keeps one owner; the one-workspace-per-user index is not recreated.
CREATE TABLE tenant_memberships_next (
 tenant_id TEXT NOT NULL REFERENCES tenants(id),
 user_id TEXT NOT NULL REFERENCES "user"(id),
 role TEXT NOT NULL CHECK (role IN ('owner','member')),
 created_at INTEGER NOT NULL,
 PRIMARY KEY (tenant_id, user_id)
);
INSERT INTO tenant_memberships_next (tenant_id, user_id, role, created_at)
 SELECT tenant_id, user_id, role, created_at FROM tenant_memberships;
DROP TABLE tenant_memberships;
ALTER TABLE tenant_memberships_next RENAME TO tenant_memberships;
CREATE UNIQUE INDEX tenant_memberships_one_owner ON tenant_memberships(tenant_id) WHERE role = 'owner';
CREATE INDEX tenant_memberships_user ON tenant_memberships(user_id, created_at);

-- The workspace each session acts in. It is only a pointer: every request checks the
-- membership again, so a pointer to a lost or deleted workspace grants nothing.
CREATE TABLE session_workspaces (
 session_id TEXT PRIMARY KEY NOT NULL REFERENCES "session"(id) ON DELETE CASCADE,
 tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 updated_at INTEGER NOT NULL
);
CREATE INDEX session_workspaces_tenant ON session_workspaces(tenant_id);

-- The workspace the user chose last, so a new sign-in opens it.
CREATE TABLE user_workspace_preferences (
 user_id TEXT PRIMARY KEY NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
 tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 updated_at INTEGER NOT NULL
);
CREATE INDEX user_workspace_preferences_tenant ON user_workspace_preferences(tenant_id);
