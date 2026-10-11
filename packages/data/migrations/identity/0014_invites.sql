-- SPDX-License-Identifier: AGPL-3.0-only
-- Members join a workspace through an invite. The member limit counts members and open invites.

-- Existing workspaces start at 2. An edition that sets other limits raises them with a policy update.
ALTER TABLE tenant_policy ADD COLUMN member_limit INTEGER NOT NULL DEFAULT 2 CHECK (member_limit >= 1);

-- One open invite per address and workspace. Only a hash of the token is stored; the address is
-- stored in lower case. An accepted or cancelled invite is deleted. An expired one stays until
-- the same address is invited again or the workspace is deleted, and no limit counts it.
CREATE TABLE tenant_invites (
 id TEXT PRIMARY KEY NOT NULL,
 tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 email TEXT NOT NULL,
 token_hash TEXT NOT NULL UNIQUE,
 invited_by TEXT REFERENCES "user"(id) ON DELETE SET NULL,
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX tenant_invites_email ON tenant_invites(tenant_id, email);

-- Invite emails sent per workspace and UTC day, so no workspace can send many emails.
CREATE TABLE tenant_invite_days (
 tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 day INTEGER NOT NULL,
 count INTEGER NOT NULL,
 PRIMARY KEY (tenant_id, day)
);
