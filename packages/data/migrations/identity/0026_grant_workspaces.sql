-- SPDX-License-Identifier: AGPL-3.0-only
-- More workspaces for an assistant's grant. A grant is the consent of one app and one user, with
-- its first workspace in "referenceId"; each row adds one more workspace to that grant. The MCP
-- endpoint still checks the person's membership in the workspace of each call.
CREATE TABLE oauth_grant_workspaces (
 client_id TEXT NOT NULL,
 user_id TEXT NOT NULL,
 grant_tenant_id TEXT NOT NULL,
 tenant_id TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 PRIMARY KEY (client_id, user_id, grant_tenant_id, tenant_id),
 CHECK (tenant_id <> grant_tenant_id)
) WITHOUT ROWID;
CREATE INDEX oauth_grant_workspaces_tenant ON oauth_grant_workspaces(tenant_id, user_id);
