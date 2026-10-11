-- SPDX-License-Identifier: AGPL-3.0-only
-- A deletion removes one workspace or the whole account. An account deletion has a job for each
-- workspace the user owns. workspace_name lets the emails name the workspace after its tenant
-- row is gone; like contact_email, it stays only until the job ends.
ALTER TABLE tenant_deletions ADD COLUMN scope TEXT NOT NULL DEFAULT 'account' CHECK (scope IN ('account','workspace'));
ALTER TABLE tenant_deletions ADD COLUMN workspace_name TEXT;
CREATE INDEX tenant_deletions_user ON tenant_deletions(user_id) WHERE state = 'running';
