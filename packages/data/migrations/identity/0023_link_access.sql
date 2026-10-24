-- SPDX-License-Identifier: AGPL-3.0-only
-- Link access: start and end dates and passwords on links. 1 lets members set them; 0 refuses new
-- values, and values already set stay in force.
ALTER TABLE tenant_policy ADD COLUMN link_access INTEGER NOT NULL DEFAULT 0 CHECK (link_access IN (0,1));
-- A single-workspace installation has every feature. No new revision: the scheduled projection
-- fills routing (see retryProjections).
UPDATE tenant_policy SET link_access = 1
 WHERE EXISTS (SELECT 1 FROM installation WHERE id = 1 AND mode = 'single')
   AND tenant_id NOT IN (SELECT tenant_id FROM tenant_deletions);
