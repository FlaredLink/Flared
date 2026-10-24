-- SPDX-License-Identifier: AGPL-3.0-only
-- Pages: the number a workspace may keep (0 turns pages off), and page extras. page_extras 1
-- removes the badge and lets members add payment, embed, and sign-up blocks and show a page on a
-- workspace domain; 0 refuses new extras, and extras already set stay in force.
ALTER TABLE tenant_policy ADD COLUMN page_limit INTEGER NOT NULL DEFAULT 0 CHECK (page_limit >= 0);
ALTER TABLE tenant_policy ADD COLUMN page_extras INTEGER NOT NULL DEFAULT 0 CHECK (page_extras IN (0,1));
-- A single-workspace installation starts at 25 pages with every extra; the owner changes the
-- limit on the Limits page. No new revision: the scheduled projection fills routing (see
-- retryProjections).
UPDATE tenant_policy SET page_limit = 25, page_extras = 1
 WHERE EXISTS (SELECT 1 FROM installation WHERE id = 1 AND mode = 'single')
   AND tenant_id NOT IN (SELECT tenant_id FROM tenant_deletions);
