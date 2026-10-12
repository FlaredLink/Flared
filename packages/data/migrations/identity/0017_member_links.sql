-- SPDX-License-Identifier: AGPL-3.0-only
-- Members of a standalone installation: an invite shared as a link names no address, and the
-- owner can give a member a link that sets a new password. SQLite cannot drop NOT NULL or change
-- a CHECK, so two tables are rebuilt with their rows. Nothing references either table.

-- email is NULL for an invite shared as a link: whoever opens the link creates an account.
CREATE TABLE tenant_invites_next (
 id TEXT PRIMARY KEY NOT NULL,
 tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 email TEXT,
 token_hash TEXT NOT NULL UNIQUE,
 invited_by TEXT REFERENCES "user"(id) ON DELETE SET NULL,
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL
);
INSERT INTO tenant_invites_next (id, tenant_id, email, token_hash, invited_by, created_at, expires_at)
 SELECT id, tenant_id, email, token_hash, invited_by, created_at, expires_at FROM tenant_invites;
DROP TABLE tenant_invites;
ALTER TABLE tenant_invites_next RENAME TO tenant_invites;
-- NULL addresses never conflict, so a workspace can hold several open links.
CREATE UNIQUE INDEX tenant_invites_email ON tenant_invites(tenant_id, email);

-- Adds the two password reset events. Rows keep their order (rowid), which orders events of one
-- millisecond.
CREATE TABLE tenant_member_events_next (
 id TEXT PRIMARY KEY NOT NULL,
 tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 action TEXT NOT NULL CHECK (action IN (
  'invite_sent', 'invite_resent', 'invite_cancelled', 'invite_accepted',
  'member_removed', 'member_left', 'account_deleted',
  'transfer_offered', 'transfer_withdrawn', 'transfer_declined', 'owner_changed',
  'password_reset_issued', 'password_reset_used'
 )),
 actor_user_id TEXT NOT NULL,
 subject_user_id TEXT,
 invite_id TEXT,
 created_at INTEGER NOT NULL
);
INSERT INTO tenant_member_events_next (id, tenant_id, action, actor_user_id, subject_user_id, invite_id, created_at)
 SELECT id, tenant_id, action, actor_user_id, subject_user_id, invite_id, created_at
 FROM tenant_member_events ORDER BY rowid;
DROP TABLE tenant_member_events;
ALTER TABLE tenant_member_events_next RENAME TO tenant_member_events;
CREATE INDEX tenant_member_events_tenant ON tenant_member_events(tenant_id, created_at);
CREATE INDEX tenant_member_events_time ON tenant_member_events(created_at);

-- The owner's open link that lets a member set a new password: one per member and workspace, for
-- 24 hours. Only a hash of the token is stored. Using it ends the member's sessions. It counts
-- only while the person is still a member, and goes with the member's removal or the workspace.
CREATE TABLE member_password_resets (
 tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
 token_hash TEXT NOT NULL UNIQUE,
 created_by TEXT REFERENCES "user"(id) ON DELETE SET NULL,
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL,
 PRIMARY KEY (tenant_id, user_id)
);
