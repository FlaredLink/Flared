-- SPDX-License-Identifier: AGPL-3.0-only
-- analytics_revision is the newest revision the tenant's analytics shard has acknowledged,
-- like routing_revision for the routing store. A tenant activates when both hold its policy.
ALTER TABLE tenant_policy ADD COLUMN analytics_revision INTEGER NOT NULL DEFAULT 0 CHECK (analytics_revision >= 0);
CREATE INDEX tenant_policy_analytics_pending ON tenant_policy(tenant_id) WHERE analytics_revision < revision;
