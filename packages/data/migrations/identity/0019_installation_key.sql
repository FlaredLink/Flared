-- SPDX-License-Identifier: AGPL-3.0-only
-- The auth secret that a standalone Worker makes for itself when the deployment sets no
-- AUTH_SECRET. Additive: the cloud never writes it. One row, written once by the first request
-- that needs it; it never changes, so sessions survive every deploy.
CREATE TABLE installation_key (
 id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
 auth_secret TEXT NOT NULL CHECK (length(auth_secret) BETWEEN 32 AND 256),
 created_at INTEGER NOT NULL
);
