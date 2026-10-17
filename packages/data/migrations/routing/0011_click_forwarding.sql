-- SPDX-License-Identifier: AGPL-3.0-only
-- 1 while an edition forwards this workspace's clicks to another service. The redirect then sets a
-- visitor cookie and its click events carry the cookie value, the visitor's user agent, the short URL,
-- and the destination's utm_* tags for that forwarder, which must not store them. Effective only while
-- webhook_endpoint_limit > 0. Not part of the revisioned policy projection: the edition sets it.
ALTER TABLE tenant_policy ADD COLUMN click_forwarding INTEGER NOT NULL DEFAULT 0 CHECK (click_forwarding IN (0,1));
CREATE INDEX tenant_policy_click_forwarding ON tenant_policy(tenant_id) WHERE click_forwarding = 1;
