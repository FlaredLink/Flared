-- SPDX-License-Identifier: AGPL-3.0-only
-- Operator blocks for abuse. A block is separate from the owner's on/off status, so clearing it
-- never turns on a link that its owner turned off. The reason is the abuse category the owner
-- sees. A suspended tenant's links do not redirect; the column comes from the identity policy.
ALTER TABLE links ADD COLUMN blocked_at INTEGER;
ALTER TABLE links ADD COLUMN blocked_reason TEXT
 CHECK (blocked_reason IN ('phishing','malware','spam','illegal','other'));
ALTER TABLE tenant_policy ADD COLUMN suspended_at INTEGER;
