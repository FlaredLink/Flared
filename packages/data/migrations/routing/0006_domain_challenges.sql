-- SPDX-License-Identifier: AGPL-3.0-only
-- Own domains of a standalone Worker: one random challenge for each claim of a workspace
-- hostname. The Worker serves it only on that exact hostname while the claim waits; fetching it
-- back over HTTPS proves the hostname reaches this Worker. A used challenge is never served again.
CREATE TABLE domain_challenges (
 domain_id TEXT NOT NULL,
 claimed_at INTEGER NOT NULL,
 challenge TEXT NOT NULL,
 expires_at INTEGER NOT NULL,
 consumed_at INTEGER,
 -- The last fetch of the challenge, so scheduled checks take turns.
 checked_at INTEGER,
 PRIMARY KEY (domain_id, claimed_at)
);
CREATE INDEX domain_challenges_expiry ON domain_challenges(expires_at);
