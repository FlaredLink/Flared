-- SPDX-License-Identifier: AGPL-3.0-only
-- An operator suspension of a tenant. It is part of the source policy, so a change takes the
-- next revision and the routing projection stops or restores the tenant's redirects.
ALTER TABLE tenant_policy ADD COLUMN suspended_at INTEGER;
ALTER TABLE tenant_policy ADD COLUMN suspended_reason TEXT
 CHECK (suspended_reason IN ('phishing','malware','spam','illegal','other'));
