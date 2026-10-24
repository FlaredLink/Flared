-- SPDX-License-Identifier: AGPL-3.0-only
-- Page views, apart from link clicks: they never count against the monthly click allowance, and
-- the retention and the daily purge are the same as for clicks. Rowid tables, so the purge and
-- deleteAnalyticsData can remove them in rounds.
CREATE TABLE page_daily_totals (
 tenant_id TEXT NOT NULL,
 page_id TEXT NOT NULL,
 day TEXT NOT NULL,
 views INTEGER NOT NULL CHECK (views >= 0),
 PRIMARY KEY (tenant_id, page_id, day)
);
CREATE INDEX page_daily_totals_day ON page_daily_totals(day);

-- Separate breakdowns, as daily_dimensions: at most 50 referrer host names per page and day,
-- plus "other".
CREATE TABLE page_daily_dimensions (
 tenant_id TEXT NOT NULL,
 page_id TEXT NOT NULL,
 day TEXT NOT NULL,
 dimension TEXT NOT NULL CHECK (dimension IN ('country','device','referrer','browser','os')),
 value TEXT NOT NULL,
 views INTEGER NOT NULL CHECK (views >= 0),
 PRIMARY KEY (tenant_id, page_id, day, dimension, value)
);
CREATE INDEX page_daily_dimensions_day ON page_daily_dimensions(day);
