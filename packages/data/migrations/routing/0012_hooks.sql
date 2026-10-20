-- SPDX-License-Identifier: AGPL-3.0-only
-- REST hooks: endpoints of the resthook transport that a client such as Zapier subscribes through
-- the API. A hook gets no event that happens at or after expires_at, and cleanup deletes it after
-- that time. NULL for every other endpoint, which does not expire.
ALTER TABLE webhook_endpoints ADD COLUMN expires_at INTEGER;
CREATE INDEX webhook_endpoints_expiry ON webhook_endpoints(expires_at) WHERE expires_at IS NOT NULL;
