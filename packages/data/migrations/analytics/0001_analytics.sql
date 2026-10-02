-- SPDX-License-Identifier: AGPL-3.0-only
-- One analytics shard. Every row of a tenant lives on the shard its policy names.

-- Projection of the identity policy fields that ingestion and reads need.
CREATE TABLE tenant_policy (
 tenant_id TEXT PRIMARY KEY NOT NULL,
 revision INTEGER NOT NULL CHECK (revision >= 1),
 monthly_click_limit INTEGER NOT NULL CHECK (monthly_click_limit >= 0),
 retention_days INTEGER NOT NULL CHECK (retention_days >= 1),
 updated_at INTEGER NOT NULL
);

-- One row per event ID. attempt_token belongs to the attempt that inserted the row; a later
-- attempt never changes it, so a replay after a committed attempt changes nothing.
CREATE TABLE event_receipts (
 tenant_id TEXT NOT NULL,
 event_id TEXT NOT NULL,
 attempt_token TEXT NOT NULL,
 outcome TEXT NOT NULL CHECK (outcome IN ('pending','admitted','skipped')),
 received_at INTEGER NOT NULL,
 PRIMARY KEY (tenant_id, event_id)
) WITHOUT ROWID;
CREATE INDEX event_receipts_received ON event_receipts(received_at);

-- UTC days as YYYY-MM-DD and months as YYYY-MM.
CREATE TABLE daily_totals (
 tenant_id TEXT NOT NULL,
 link_id TEXT NOT NULL,
 day TEXT NOT NULL,
 clicks INTEGER NOT NULL CHECK (clicks >= 0),
 PRIMARY KEY (tenant_id, link_id, day)
);
CREATE INDEX daily_totals_day ON daily_totals(day);

-- Separate breakdowns, not combinations. value is a bounded set: country codes, device
-- categories, and at most 50 referrer host names per link and day plus "other".
CREATE TABLE daily_dimensions (
 tenant_id TEXT NOT NULL,
 link_id TEXT NOT NULL,
 day TEXT NOT NULL,
 dimension TEXT NOT NULL CHECK (dimension IN ('country','device','referrer')),
 value TEXT NOT NULL,
 clicks INTEGER NOT NULL CHECK (clicks >= 0),
 PRIMARY KEY (tenant_id, link_id, day, dimension, value)
);
CREATE INDEX daily_dimensions_day ON daily_dimensions(day);

-- Recorded clicks per UTC calendar month, compared with the monthly allowance.
CREATE TABLE monthly_usage (
 tenant_id TEXT NOT NULL,
 month TEXT NOT NULL,
 clicks INTEGER NOT NULL CHECK (clicks >= 0),
 PRIMARY KEY (tenant_id, month)
);
