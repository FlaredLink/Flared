-- SPDX-License-Identifier: AGPL-3.0-only
-- Counted clicks per link since tracking began, seeded from the retained daily totals on the first
-- counted click. A rowid table, so deleteAnalyticsData can remove it in rounds.
CREATE TABLE link_click_totals (
 tenant_id TEXT NOT NULL,
 link_id TEXT NOT NULL,
 clicks INTEGER NOT NULL CHECK (clicks >= 0),
 last_event_id TEXT NOT NULL,
 updated_at INTEGER NOT NULL,
 PRIMARY KEY (tenant_id, link_id)
);
-- Each multiple of 100, once. id is link.click_milestone:<linkId>:<clicks>. The scheduled job moves
-- rows to routing and deletes them.
CREATE TABLE click_milestones (
 id TEXT PRIMARY KEY NOT NULL,
 tenant_id TEXT NOT NULL,
 link_id TEXT NOT NULL,
 clicks INTEGER NOT NULL CHECK (clicks > 0 AND clicks % 100 = 0),
 created_at INTEGER NOT NULL
);
CREATE INDEX click_milestones_created ON click_milestones(created_at);
CREATE INDEX click_milestones_tenant ON click_milestones(tenant_id);
