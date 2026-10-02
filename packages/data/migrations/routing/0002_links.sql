-- SPDX-License-Identifier: AGPL-3.0-only
-- A hostname keeps its namespace ID forever, so removing and adding a domain again cannot
-- reopen its slugs.
CREATE TABLE domain_namespaces (
 id TEXT PRIMARY KEY NOT NULL,
 hostname TEXT NOT NULL UNIQUE,
 created_at INTEGER NOT NULL
);

-- tenant_id NULL marks a platform domain that every tenant may use.
CREATE TABLE domains (
 id TEXT PRIMARY KEY NOT NULL REFERENCES domain_namespaces(id),
 tenant_id TEXT,
 state TEXT NOT NULL CHECK (state IN ('pending','active','disabled')),
 is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 CHECK (is_default = 0 OR tenant_id IS NULL)
);
CREATE UNIQUE INDEX domains_one_default ON domains(is_default) WHERE is_default = 1;
CREATE INDEX domains_tenant ON domains(tenant_id);

-- Permanent: no owner, no expiry, no cascade. A deleted link never frees its slug.
CREATE TABLE slug_reservations (
 domain_id TEXT NOT NULL REFERENCES domain_namespaces(id),
 slug TEXT NOT NULL,
 PRIMARY KEY (domain_id, slug)
) WITHOUT ROWID;
CREATE TRIGGER slug_reservations_kept BEFORE DELETE ON slug_reservations
BEGIN
 SELECT RAISE(ABORT, 'slug reservations are permanent');
END;
CREATE TRIGGER slug_reservations_fixed BEFORE UPDATE ON slug_reservations
BEGIN
 SELECT RAISE(ABORT, 'slug reservations are permanent');
END;

CREATE TABLE links (
 id TEXT PRIMARY KEY NOT NULL,
 tenant_id TEXT NOT NULL,
 domain_id TEXT NOT NULL,
 slug TEXT NOT NULL,
 destination TEXT NOT NULL,
 title TEXT,
 status TEXT NOT NULL CHECK (status IN ('active','disabled')),
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 UNIQUE (domain_id, slug),
 FOREIGN KEY (domain_id, slug) REFERENCES slug_reservations(domain_id, slug)
);
CREATE INDEX links_tenant_created ON links(tenant_id, created_at, id);
CREATE INDEX links_tenant_status ON links(tenant_id, status);
CREATE TRIGGER links_address_fixed BEFORE UPDATE OF tenant_id, domain_id, slug ON links
BEGIN
 SELECT RAISE(ABORT, 'link address cannot change');
END;

-- One row per create request key. outcome is set inside the same batch that creates the link.
CREATE TABLE idempotency_records (
 tenant_id TEXT NOT NULL,
 key TEXT NOT NULL,
 request_hash TEXT NOT NULL,
 outcome TEXT NOT NULL CHECK (outcome IN ('pending','created','slug_taken','limit_reached','retry','unavailable')),
 status INTEGER,
 body TEXT,
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL,
 PRIMARY KEY (tenant_id, key)
);
CREATE INDEX idempotency_records_expiry ON idempotency_records(expires_at);

-- Fixed one-minute windows for link creation per tenant.
CREATE TABLE creation_windows (
 tenant_id TEXT NOT NULL,
 window_start INTEGER NOT NULL,
 count INTEGER NOT NULL,
 PRIMARY KEY (tenant_id, window_start)
);
