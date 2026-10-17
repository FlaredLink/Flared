-- SPDX-License-Identifier: AGPL-3.0-only
-- Automations a workspace may keep. 0 turns automations off: none can be added or applied, and due ones are skipped.
ALTER TABLE tenant_policy ADD COLUMN automation_limit INTEGER NOT NULL DEFAULT 0 CHECK (automation_limit >= 0);
-- A single-workspace installation starts at 25; the owner changes it on the Limits page. No new revision:
-- the scheduled projection fills routing (see retryProjections).
UPDATE tenant_policy SET automation_limit = 25
 WHERE EXISTS (SELECT 1 FROM installation WHERE id = 1 AND mode = 'single')
   AND tenant_id NOT IN (SELECT tenant_id FROM tenant_deletions);
