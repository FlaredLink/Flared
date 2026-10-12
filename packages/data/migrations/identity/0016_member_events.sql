-- SPDX-License-Identifier: AGPL-3.0-only
-- Who joined, left, or was invited to a workspace, and who gave it to whom. The same batch that
-- makes a change writes its row, so a change never happens without one. Rows hold user and
-- invite IDs only: no email address and no token. The user IDs have no foreign key, so a row
-- still names a deleted account. Rows expire after 90 days and go with the workspace.
CREATE TABLE tenant_member_events (
 id TEXT PRIMARY KEY NOT NULL,
 tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 action TEXT NOT NULL CHECK (action IN (
  'invite_sent', 'invite_resent', 'invite_cancelled', 'invite_accepted',
  'member_removed', 'member_left', 'account_deleted',
  'transfer_offered', 'transfer_withdrawn', 'transfer_declined', 'owner_changed'
 )),
 -- The user who made the change.
 actor_user_id TEXT NOT NULL,
 -- The member the change is about: the member removed, the receiver of an offer, or the previous
 -- owner. NULL for an invite that nobody has accepted.
 subject_user_id TEXT,
 invite_id TEXT,
 created_at INTEGER NOT NULL
);
CREATE INDEX tenant_member_events_tenant ON tenant_member_events(tenant_id, created_at);
CREATE INDEX tenant_member_events_time ON tenant_member_events(created_at);
