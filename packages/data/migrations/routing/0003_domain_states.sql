-- SPDX-License-Identifier: AGPL-3.0-only
-- Workspace domains: the verifying and failed states, claim expiry, and check times. SQLite
-- cannot change a CHECK constraint, so the table is rebuilt. No table references domains.
CREATE TABLE domains_next (
 id TEXT PRIMARY KEY NOT NULL REFERENCES domain_namespaces(id),
 tenant_id TEXT,
 state TEXT NOT NULL CHECK (state IN ('pending','verifying','active','failed','disabled')),
 is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 -- When the current claim started; a re-add starts a new claim.
 claimed_at INTEGER,
 -- An unverified claim ends here; another workspace may then add the hostname.
 claim_expires_at INTEGER,
 activated_at INTEGER,
 failure_code TEXT,
 -- The last check that a person asked for, to space them out.
 checked_at INTEGER,
 CHECK (is_default = 0 OR tenant_id IS NULL)
);
INSERT INTO domains_next (id, tenant_id, state, is_default, created_at, updated_at, claimed_at, activated_at)
 SELECT id, tenant_id, state, is_default, created_at, updated_at, created_at,
  CASE WHEN state = 'active' THEN updated_at END
 FROM domains;
DROP TABLE domains;
ALTER TABLE domains_next RENAME TO domains;
CREATE UNIQUE INDEX domains_one_default ON domains(is_default) WHERE is_default = 1;
CREATE INDEX domains_tenant ON domains(tenant_id, state);
CREATE INDEX links_domain_status ON links(domain_id, status);
