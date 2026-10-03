-- SPDX-License-Identifier: AGPL-3.0-only
-- Notices to a workspace owner, such as usage warnings. dedupe_key makes each notice happen
-- once. params holds only counts and dates, never destinations or visitor data.
-- States: pending (waits for the dispatcher), sending (claimed), sent, delivery_unknown (the
-- send may or may not have happened; never resent), undeliverable (no verified contact).
CREATE TABLE notices (
 id TEXT PRIMARY KEY NOT NULL,
 tenant_id TEXT NOT NULL REFERENCES tenants(id),
 kind TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 64),
 dedupe_key TEXT NOT NULL UNIQUE,
 params TEXT NOT NULL CHECK (json_valid(params)),
 state TEXT NOT NULL DEFAULT 'pending'
  CHECK (state IN ('pending','sending','sent','delivery_unknown','undeliverable')),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
 claimed_at INTEGER,
 created_at INTEGER NOT NULL,
 sent_at INTEGER
);
CREATE INDEX notices_pending ON notices(created_at) WHERE state = 'pending';
CREATE INDEX notices_sending ON notices(claimed_at) WHERE state = 'sending';
CREATE INDEX notices_created ON notices(created_at);
CREATE INDEX notices_tenant ON notices(tenant_id, created_at);
