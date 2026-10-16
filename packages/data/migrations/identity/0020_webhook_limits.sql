-- SPDX-License-Identifier: AGPL-3.0-only
-- Webhook endpoints a workspace may keep. 0 turns webhooks off: none can be added and nothing is delivered.
ALTER TABLE tenant_policy ADD COLUMN webhook_endpoint_limit INTEGER NOT NULL DEFAULT 0 CHECK (webhook_endpoint_limit >= 0);
-- A single-workspace installation starts at 10; the owner changes it on the Limits page. No new revision:
-- the scheduled projection fills routing (see retryProjections).
UPDATE tenant_policy SET webhook_endpoint_limit = 10
 WHERE EXISTS (SELECT 1 FROM installation WHERE id = 1 AND mode = 'single')
   AND tenant_id NOT IN (SELECT tenant_id FROM tenant_deletions);
