-- SPDX-License-Identifier: AGPL-3.0-only
-- Workspace deletion. One row per tenant: a running job, then the deletion ledger that restore
-- procedures reapply. tenant_id has no foreign key, because the tenant row goes before the job
-- ends. contact_email holds the owner's address only until the completion email.
CREATE TABLE tenant_deletions (
 tenant_id TEXT PRIMARY KEY NOT NULL,
 user_id TEXT NOT NULL,
 analytics_shard_id TEXT NOT NULL,
 contact_email TEXT,
 state TEXT NOT NULL CHECK (state IN ('running','completed')),
 step TEXT NOT NULL CHECK (step IN ('accepted','routing','wait','analytics','routing_data','extension','identity','completed_notice','done')),
 requested_at INTEGER NOT NULL,
 routes_stopped_at INTEGER,
 completed_at INTEGER,
 attempts INTEGER NOT NULL DEFAULT 0,
 next_attempt_at INTEGER NOT NULL,
 last_error_code TEXT,
 CHECK (state = 'running' OR contact_email IS NULL)
);
CREATE INDEX tenant_deletions_due ON tenant_deletions(next_attempt_at) WHERE state = 'running';
CREATE INDEX tenant_deletions_completed ON tenant_deletions(completed_at) WHERE state = 'completed';

-- A single-workspace installation closes when its workspace is deleted. Setup never reopens.
ALTER TABLE installation ADD COLUMN closed_at INTEGER;
CREATE TRIGGER tenants_closed_installation BEFORE INSERT ON tenants
WHEN (SELECT closed_at FROM installation WHERE id = 1) IS NOT NULL
BEGIN
 SELECT RAISE(ABORT, 'installation is closed');
END;
