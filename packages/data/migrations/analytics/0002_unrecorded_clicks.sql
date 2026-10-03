-- SPDX-License-Identifier: AGPL-3.0-only
-- Clicks that arrived after the monthly allowance was full. They are counted, never recorded,
-- so the dashboard can say how many clicks are missing and since when.
ALTER TABLE monthly_usage ADD COLUMN skipped_clicks INTEGER NOT NULL DEFAULT 0 CHECK (skipped_clicks >= 0);
ALTER TABLE monthly_usage ADD COLUMN first_skipped_at INTEGER;

-- The usage notice job reads one month across tenants.
CREATE INDEX monthly_usage_month ON monthly_usage(month);
