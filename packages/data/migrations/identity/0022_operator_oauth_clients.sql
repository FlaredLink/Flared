-- SPDX-License-Identifier: AGPL-3.0-only
-- OAuth clients that the operator registered for the REST API. Only the operator's registration
-- writes here, so no client can mark itself: cleanup keeps these clients while nobody has
-- connected, and the operator lists and disables them.
CREATE TABLE oauth_operator_clients (
 client_id TEXT PRIMARY KEY NOT NULL REFERENCES "oauthClient"("clientId") ON DELETE CASCADE,
 created_at INTEGER NOT NULL
);
