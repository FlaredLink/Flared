-- SPDX-License-Identifier: AGPL-3.0-only
-- Endpoints delivered by an edition's own transport. 'http' is the signed POST; another transport
-- needs the edition's sender, or its deliveries fail with transport_missing. For those rows url is
-- an https link that opens the target, key_id is 'transport', target_key is unique per workspace
-- and transport, and target is the edition's JSON, which the core never reads.
ALTER TABLE webhook_endpoints ADD COLUMN transport TEXT NOT NULL DEFAULT 'http'
 CHECK (length(transport) BETWEEN 2 AND 16 AND transport NOT GLOB '*[^a-z]*');
ALTER TABLE webhook_endpoints ADD COLUMN target_key TEXT CHECK (target_key IS NULL OR length(target_key) BETWEEN 1 AND 160);
ALTER TABLE webhook_endpoints ADD COLUMN target TEXT CHECK (target IS NULL OR (json_valid(target) AND length(target) <= 2048));
-- Why Flared turned the endpoint off; the owner turning it on or off clears it.
ALTER TABLE webhook_endpoints ADD COLUMN off_reason TEXT CHECK (off_reason IS NULL OR off_reason IN ('target_unavailable','unauthorized'));
CREATE UNIQUE INDEX webhook_endpoints_target ON webhook_endpoints(tenant_id, transport, target_key) WHERE target_key IS NOT NULL;
CREATE INDEX webhook_endpoints_transport ON webhook_endpoints(transport, target_key, id) WHERE transport <> 'http';

-- post_message posts through a transport endpoint. SQLite cannot change the at-least-one-action
-- CHECK, so automations is rebuilt with the columns, CHECKs, and indexes of 0009 plus
-- message_endpoint_id. Dropping a parent runs its ON DELETE CASCADE even with deferred keys, so
-- link_automations is rebuilt against automations_next and the old child is dropped first.
-- Renaming automations_next renames the reference. automation_runs has no key and stays.
-- message_endpoint_id has no foreign key, as webhook_endpoint_id: runs record target_missing.
CREATE TABLE automations_next (
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
 message_endpoint_id TEXT,
 email_owner INTEGER NOT NULL DEFAULT 0 CHECK (email_owner IN (0,1)),
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 CHECK ((trigger_type = 'link_age') = (trigger_days IS NOT NULL)),
 CHECK ((trigger_type = 'clicks') = (trigger_clicks IS NOT NULL)),
 CHECK (set_destination IS NOT NULL OR disable_link = 1 OR webhook_endpoint_id IS NOT NULL OR message_endpoint_id IS NOT NULL OR email_owner = 1)
);
INSERT INTO automations_next (id, tenant_id, name, enabled, trigger_type, trigger_days, trigger_clicks, set_destination, disable_link, webhook_endpoint_id, email_owner, created_at, updated_at)
 SELECT id, tenant_id, name, enabled, trigger_type, trigger_days, trigger_clicks, set_destination, disable_link, webhook_endpoint_id, email_owner, created_at, updated_at FROM automations;

CREATE TABLE link_automations_next (
 tenant_id TEXT NOT NULL,
 link_id TEXT NOT NULL,
 automation_id TEXT NOT NULL REFERENCES automations_next(id) ON DELETE CASCADE,
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
-- In rowid order: claims and checks break ties by rowid.
INSERT INTO link_automations_next (tenant_id, link_id, automation_id, trigger_type, state, ends_at, due_at, reached_clicks, armed_at, claim_token, claimed_until, attempts, check_key, check_failures, last_checked_at, last_check_result, fired_at, result_code, created_at, updated_at)
 SELECT tenant_id, link_id, automation_id, trigger_type, state, ends_at, due_at, reached_clicks, armed_at, claim_token, claimed_until, attempts, check_key, check_failures, last_checked_at, last_check_result, fired_at, result_code, created_at, updated_at FROM link_automations ORDER BY rowid;

DROP TABLE link_automations;
DROP TABLE automations;
ALTER TABLE automations_next RENAME TO automations;
ALTER TABLE link_automations_next RENAME TO link_automations;
CREATE INDEX automations_tenant ON automations(tenant_id, created_at);
CREATE INDEX link_automations_due ON link_automations(due_at) WHERE state = 'waiting' AND due_at IS NOT NULL;
CREATE INDEX link_automations_checks ON link_automations(last_checked_at) WHERE state = 'waiting' AND trigger_type = 'destination_down';
CREATE INDEX link_automations_automation ON link_automations(automation_id, state);
CREATE INDEX link_automations_tenant ON link_automations(tenant_id);
