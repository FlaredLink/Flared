-- SPDX-License-Identifier: AGPL-3.0-only
-- Click consumer counts for each UTC minute on this shard, for the operator's health view.
-- minute is the start of the minute in milliseconds. lag is consume time minus occurred time.
-- Rows expire after 14 days.
CREATE TABLE ingestion_minutes (
 minute INTEGER PRIMARY KEY NOT NULL,
 counted INTEGER NOT NULL DEFAULT 0 CHECK (counted >= 0),
 duplicates INTEGER NOT NULL DEFAULT 0 CHECK (duplicates >= 0),
 dropped INTEGER NOT NULL DEFAULT 0 CHECK (dropped >= 0),
 retried INTEGER NOT NULL DEFAULT 0 CHECK (retried >= 0),
 max_lag_ms INTEGER NOT NULL DEFAULT 0 CHECK (max_lag_ms >= 0),
 last_occurred_at INTEGER
);
