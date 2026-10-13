-- SPDX-License-Identifier: AGPL-3.0-only
-- The opt-in update check of a standalone installation. Additive: the cloud never writes it.
-- One row, created when the owner first answers. The daily job writes the latest release only
-- while the check is on; turning it off clears what it found.
CREATE TABLE update_check (
 id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
 enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
 changed_at INTEGER NOT NULL,
 -- The last check that read a valid feed, and the last check that failed after it.
 checked_at INTEGER,
 failed_at INTEGER,
 latest_version TEXT,
 published_at TEXT,
 notes_url TEXT,
 summary TEXT,
 migrations INTEGER CHECK (migrations IS NULL OR migrations IN (0,1)),
 breaking INTEGER CHECK (breaking IS NULL OR breaking IN (0,1)),
 CHECK (enabled = 1 OR (checked_at IS NULL AND failed_at IS NULL AND latest_version IS NULL))
);
