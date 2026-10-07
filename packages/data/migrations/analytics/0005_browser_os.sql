-- SPDX-License-Identifier: AGPL-3.0-only
-- Browser and OS family breakdowns. SQLite cannot change a CHECK constraint, so the table is
-- rebuilt with the same columns, key, and index. Rows keep their values; clicks counted before
-- this migration have no browser or OS rows.
CREATE TABLE daily_dimensions_next (
 tenant_id TEXT NOT NULL,
 link_id TEXT NOT NULL,
 day TEXT NOT NULL,
 dimension TEXT NOT NULL CHECK (dimension IN ('country','device','referrer','browser','os')),
 value TEXT NOT NULL,
 clicks INTEGER NOT NULL CHECK (clicks >= 0),
 PRIMARY KEY (tenant_id, link_id, day, dimension, value)
);
INSERT INTO daily_dimensions_next (tenant_id, link_id, day, dimension, value, clicks)
 SELECT tenant_id, link_id, day, dimension, value, clicks FROM daily_dimensions;
DROP TABLE daily_dimensions;
ALTER TABLE daily_dimensions_next RENAME TO daily_dimensions;
CREATE INDEX daily_dimensions_day ON daily_dimensions(day);
