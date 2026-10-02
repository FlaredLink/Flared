-- SPDX-License-Identifier: AGPL-3.0-only
-- One row describes the installation. The deployment inserts it; nothing may change its mode.
CREATE TABLE installation (
 id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
 mode TEXT NOT NULL CHECK (mode IN ('single','multi')),
 fixed_tenant_id TEXT,
 created_at INTEGER NOT NULL,
 CHECK (mode = 'single' OR fixed_tenant_id IS NULL)
);
CREATE TRIGGER installation_mode_fixed BEFORE UPDATE OF mode ON installation
BEGIN
 SELECT RAISE(ABORT, 'installation mode cannot change');
END;
CREATE TRIGGER installation_kept BEFORE DELETE ON installation
BEGIN
 SELECT RAISE(ABORT, 'installation cannot be deleted');
END;

-- A tenant is pending until every store it depends on holds its initial policy.
CREATE TABLE tenants (
 id TEXT PRIMARY KEY NOT NULL,
 name TEXT NOT NULL,
 analytics_shard_id TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 activated_at INTEGER
);
CREATE TRIGGER tenants_need_installation BEFORE INSERT ON tenants
WHEN NOT EXISTS (SELECT 1 FROM installation)
BEGIN
 SELECT RAISE(ABORT, 'installation is not configured');
END;
CREATE TRIGGER tenants_single_mode BEFORE INSERT ON tenants
WHEN (SELECT mode FROM installation WHERE id = 1) = 'single'
 AND EXISTS (SELECT 1 FROM tenants WHERE id <> NEW.id)
BEGIN
 SELECT RAISE(ABORT, 'single installation already has a tenant');
END;

CREATE TABLE tenant_memberships (
 tenant_id TEXT NOT NULL REFERENCES tenants(id),
 user_id TEXT NOT NULL REFERENCES "user"(id),
 role TEXT NOT NULL CHECK (role IN ('owner')),
 created_at INTEGER NOT NULL,
 PRIMARY KEY (tenant_id, user_id)
);
CREATE UNIQUE INDEX tenant_memberships_one_owner ON tenant_memberships(tenant_id) WHERE role = 'owner';
-- V1 gives each user one workspace. Team workspaces replace this index with a plain one.
CREATE UNIQUE INDEX tenant_memberships_one_per_user ON tenant_memberships(user_id);

-- The source policy. routing_revision is the newest revision the routing store has acknowledged,
-- so a row with routing_revision < revision is an outstanding projection.
CREATE TABLE tenant_policy (
 tenant_id TEXT PRIMARY KEY NOT NULL REFERENCES tenants(id),
 revision INTEGER NOT NULL CHECK (revision >= 1),
 active_link_limit INTEGER NOT NULL CHECK (active_link_limit >= 0),
 monthly_click_limit INTEGER NOT NULL CHECK (monthly_click_limit >= 0),
 retention_days INTEGER NOT NULL CHECK (retention_days >= 1),
 domain_limit INTEGER NOT NULL CHECK (domain_limit >= 0),
 updated_at INTEGER NOT NULL,
 routing_revision INTEGER NOT NULL DEFAULT 0 CHECK (routing_revision >= 0)
);
CREATE INDEX tenant_policy_routing_pending ON tenant_policy(tenant_id) WHERE routing_revision < revision;
