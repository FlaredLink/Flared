-- SPDX-License-Identifier: AGPL-3.0-only
-- NULL: not projected by a version that knows automations yet; counts as 0.
ALTER TABLE tenant_policy ADD COLUMN automation_limit INTEGER CHECK (automation_limit IS NULL OR automation_limit >= 0);

-- A template: one trigger, then its actions in a fixed order. trigger_type never changes.
-- webhook_endpoint_id has no foreign key: a deleted endpoint leaves the template, and its runs record endpoint_missing.
CREATE TABLE automations (
 id TEXT PRIMARY KEY NOT NULL,
 tenant_id TEXT NOT NULL,
 name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
 enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
 trigger_type TEXT NOT NULL CHECK (trigger_type IN ('end_date','link_age','clicks','destination_down')),
 trigger_days INTEGER CHECK (trigger_days IS NULL OR trigger_days BETWEEN 1 AND 3650),
 trigger_clicks INTEGER CHECK (trigger_clicks IS NULL OR (trigger_clicks BETWEEN 100 AND 100000000 AND trigger_clicks % 100 = 0)),
 set_destination TEXT CHECK (set_destination IS NULL OR length(set_destination) BETWEEN 1 AND 4096),
 disable_link INTEGER NOT NULL DEFAULT 0 CHECK (disable_link IN (0,1)),
 webhook_endpoint_id TEXT,
 email_owner INTEGER NOT NULL DEFAULT 0 CHECK (email_owner IN (0,1)),
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 CHECK ((trigger_type = 'link_age') = (trigger_days IS NOT NULL)),
 CHECK ((trigger_type = 'clicks') = (trigger_clicks IS NOT NULL)),
 CHECK (set_destination IS NOT NULL OR disable_link = 1 OR webhook_endpoint_id IS NOT NULL OR email_owner = 1)
);
CREATE INDEX automations_tenant ON automations(tenant_id, created_at);

-- A template applied to a link. Runs once; a re-apply re-arms it. No foreign key to links: deletion removes these first.
CREATE TABLE link_automations (
 tenant_id TEXT NOT NULL,
 link_id TEXT NOT NULL,
 automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
 trigger_type TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'waiting' CHECK (state IN ('waiting','done','failed','skipped')),
 ends_at INTEGER,
 due_at INTEGER,
 reached_clicks INTEGER,
 armed_at INTEGER NOT NULL,
 claim_token TEXT,
 claimed_until INTEGER,
 attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
 check_key TEXT,
 check_failures INTEGER NOT NULL DEFAULT 0 CHECK (check_failures >= 0),
 last_checked_at INTEGER,
 last_check_result TEXT,
 fired_at INTEGER,
 result_code TEXT,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 PRIMARY KEY (link_id, automation_id)
);
CREATE INDEX link_automations_due ON link_automations(due_at) WHERE state = 'waiting' AND due_at IS NOT NULL;
CREATE INDEX link_automations_checks ON link_automations(last_checked_at) WHERE state = 'waiting' AND trigger_type = 'destination_down';
CREATE INDEX link_automations_automation ON link_automations(automation_id, state);
CREATE INDEX link_automations_tenant ON link_automations(tenant_id);

-- What each run did, for the automation page. Kept 90 days. The name is a copy, so a rename keeps history readable.
CREATE TABLE automation_runs (
 id TEXT PRIMARY KEY NOT NULL,
 tenant_id TEXT NOT NULL,
 automation_id TEXT NOT NULL,
 automation_name TEXT NOT NULL,
 link_id TEXT NOT NULL,
 claim_token TEXT NOT NULL,
 state TEXT NOT NULL CHECK (state IN ('succeeded','failed','skipped')),
 result_code TEXT,
 actions TEXT NOT NULL CHECK (json_valid(actions) AND json_type(actions) = 'array'),
 email INTEGER NOT NULL DEFAULT 0 CHECK (email IN (0,1)),
 created_at INTEGER NOT NULL
);
CREATE INDEX automation_runs_automation ON automation_runs(automation_id, created_at);
CREATE INDEX automation_runs_claim ON automation_runs(claim_token);
CREATE INDEX automation_runs_created ON automation_runs(created_at);
CREATE INDEX automation_runs_tenant ON automation_runs(tenant_id);
