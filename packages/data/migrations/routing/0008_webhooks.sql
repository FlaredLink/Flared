-- SPDX-License-Identifier: AGPL-3.0-only
-- NULL: not projected by a version that knows webhooks yet; counts as 0.
ALTER TABLE tenant_policy ADD COLUMN webhook_endpoint_limit INTEGER CHECK (webhook_endpoint_limit IS NULL OR webhook_endpoint_limit >= 0);

-- Secrets are derived from the deployment secret, endpoint ID, and secret_version; none is stored.
-- key_id fingerprints the deployment key the secret came from.
CREATE TABLE webhook_endpoints (
 id TEXT PRIMARY KEY NOT NULL,
 tenant_id TEXT NOT NULL,
 url TEXT NOT NULL CHECK (length(url) BETWEEN 12 AND 2048 AND substr(url, 1, 8) = 'https://'),
 events TEXT NOT NULL CHECK (json_valid(events) AND json_type(events) = 'array'),
 milestone_interval INTEGER CHECK (milestone_interval IS NULL OR (milestone_interval BETWEEN 100 AND 1000000 AND milestone_interval % 100 = 0)),
 enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
 secret_version INTEGER NOT NULL DEFAULT 1 CHECK (secret_version >= 1),
 previous_secret_until INTEGER,
 key_id TEXT NOT NULL,
 failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
 paused_until INTEGER,
 last_success_at INTEGER,
 last_failure_at INTEGER,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);
CREATE INDEX webhook_endpoints_tenant ON webhook_endpoints(tenant_id, created_at);

-- One row per event. payload is the event's data object; the envelope is built when sending.
-- target_endpoint_id: delivered to that endpoint only (test events; later automations).
CREATE TABLE webhook_events (
 id TEXT PRIMARY KEY NOT NULL,
 tenant_id TEXT NOT NULL,
 type TEXT NOT NULL CHECK (length(type) BETWEEN 3 AND 64),
 subject_id TEXT,
 target_endpoint_id TEXT,
 payload TEXT NOT NULL CHECK (json_valid(payload) AND length(payload) <= 65536),
 created_at INTEGER NOT NULL,
 fanned_out_at INTEGER
);
CREATE INDEX webhook_events_pending ON webhook_events(created_at, id) WHERE fanned_out_at IS NULL;
CREATE INDEX webhook_events_created ON webhook_events(created_at);
CREATE INDEX webhook_events_tenant ON webhook_events(tenant_id, created_at);

CREATE TABLE webhook_deliveries (
 id TEXT PRIMARY KEY NOT NULL,
 tenant_id TEXT NOT NULL,
 event_id TEXT NOT NULL REFERENCES webhook_events(id) ON DELETE CASCADE,
 endpoint_id TEXT NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
 state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','succeeded','failed','skipped')),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
 next_attempt_at INTEGER NOT NULL,
 last_attempt_at INTEGER,
 response_status INTEGER,
 error_code TEXT,            -- timeout | network | redirect | http_status | invalid_url | secret_changed | plan | disabled | expired (checked in TS)
 duration_ms INTEGER,
 created_at INTEGER NOT NULL,
 completed_at INTEGER,
 UNIQUE (event_id, endpoint_id)
);
CREATE INDEX webhook_deliveries_due ON webhook_deliveries(next_attempt_at) WHERE state = 'pending';
CREATE INDEX webhook_deliveries_endpoint ON webhook_deliveries(endpoint_id, created_at);
CREATE INDEX webhook_deliveries_created ON webhook_deliveries(created_at);
CREATE INDEX webhook_deliveries_tenant ON webhook_deliveries(tenant_id);
