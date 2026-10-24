-- SPDX-License-Identifier: AGPL-3.0-only
-- Link access. NULL: not projected by a version that knows link access yet; counts as 0.
ALTER TABLE tenant_policy ADD COLUMN link_access INTEGER CHECK (link_access IS NULL OR link_access IN (0,1));
-- The link opens at starts_at and stops at ends_at (UTC milliseconds); NULL is no bound. After the
-- end, visitors go to ended_destination, or see the unavailable page when it is NULL.
ALTER TABLE links ADD COLUMN starts_at INTEGER;
ALTER TABLE links ADD COLUMN ends_at INTEGER CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at);
ALTER TABLE links ADD COLUMN ended_destination TEXT CHECK (ended_destination IS NULL OR length(ended_destination) BETWEEN 1 AND 4096);
-- A keyed hash (hmac-pbkdf2-sha256$...). Visitors enter the password before the redirect.
ALTER TABLE links ADD COLUMN password_hash TEXT CHECK (password_hash IS NULL OR password_hash LIKE 'hmac-pbkdf2-sha256$%');
