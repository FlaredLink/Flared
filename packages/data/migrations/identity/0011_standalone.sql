-- SPDX-License-Identifier: AGPL-3.0-only
-- The standalone owner, setup, and request budgets. Additive: cloud rows keep NULL usernames,
-- and the new tables stay empty in the cloud.

-- The Better Auth 1.7.7 username plugin stores the lowercase username and the name as typed.
ALTER TABLE "user" ADD COLUMN username TEXT;
ALTER TABLE "user" ADD COLUMN displayUsername TEXT;
CREATE UNIQUE INDEX user_username_unique ON "user"(username) WHERE username IS NOT NULL;

-- One account per provider and user, so a repeated setup step cannot link a second password.
CREATE UNIQUE INDEX account_user_provider ON account(userId, providerId);

-- The standalone setup claim. The first proven request fixes every value; a retry with the
-- setup secret resumes this claim and never replaces it. The password hash waits here until
-- the credential account exists and is cleared on activation. app_origin is the origin the
-- owner last signed in at with a password.
CREATE TABLE installation_setup (
 id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
 state TEXT NOT NULL CHECK (state IN ('initializing','active')),
 claim_id TEXT NOT NULL,
 user_id TEXT NOT NULL,
 tenant_id TEXT NOT NULL,
 username TEXT NOT NULL,
 workspace_name TEXT NOT NULL,
 password_hash TEXT,
 step INTEGER NOT NULL DEFAULT 0 CHECK (step BETWEEN 0 AND 4),
 app_origin TEXT NOT NULL,
 started_at INTEGER NOT NULL,
 activated_at INTEGER,
 CHECK ((state = 'active') = (activated_at IS NOT NULL)),
 CHECK (state = 'initializing' OR password_hash IS NULL)
);
CREATE TRIGGER installation_setup_needs_single BEFORE INSERT ON installation_setup
WHEN NOT EXISTS (SELECT 1 FROM installation WHERE id = 1 AND mode = 'single' AND fixed_tenant_id = NEW.tenant_id)
BEGIN
 SELECT RAISE(ABORT, 'setup needs the single installation of its tenant');
END;
CREATE TRIGGER installation_setup_fixed BEFORE UPDATE OF claim_id, user_id, tenant_id, username, workspace_name, started_at ON installation_setup
BEGIN
 SELECT RAISE(ABORT, 'setup claim cannot change');
END;
CREATE TRIGGER installation_setup_stays_active BEFORE UPDATE OF state ON installation_setup
WHEN OLD.state = 'active' AND NEW.state <> 'active'
BEGIN
 SELECT RAISE(ABORT, 'setup cannot reopen');
END;
CREATE TRIGGER installation_setup_kept BEFORE DELETE ON installation_setup
BEGIN
 SELECT RAISE(ABORT, 'setup cannot be deleted');
END;

-- One row per budgeted request, reserved before any password hash runs. key is an HMAC of the
-- request source or of the user; it never holds an address.
CREATE TABLE auth_attempts (
 id TEXT PRIMARY KEY NOT NULL,
 kind TEXT NOT NULL CHECK (kind IN ('sign_in','reauth','password_change','setup')),
 key TEXT NOT NULL,
 created_at INTEGER NOT NULL
);
CREATE INDEX auth_attempts_key ON auth_attempts(kind, key, created_at);
CREATE INDEX auth_attempts_time ON auth_attempts(kind, created_at);

-- Passkey sign-in challenges, in the shape of the shared passkey budget.
CREATE TABLE passkey_attempts (
 id TEXT PRIMARY KEY NOT NULL,
 source_key TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 utc_day INTEGER NOT NULL
);
CREATE INDEX passkey_attempts_source_time ON passkey_attempts(source_key, created_at);
CREATE INDEX passkey_attempts_day ON passkey_attempts(utc_day);
CREATE INDEX passkey_attempts_time ON passkey_attempts(created_at);

-- The last run of each scheduled job, in the shape of the shared job ledger.
CREATE TABLE job_runs (
 job TEXT PRIMARY KEY NOT NULL,
 last_started_at INTEGER NOT NULL,
 last_finished_at INTEGER NOT NULL,
 last_outcome TEXT NOT NULL CHECK (last_outcome IN ('succeeded','failed')),
 last_success_at INTEGER,
 failures INTEGER NOT NULL DEFAULT 0 CHECK (failures >= 0)
);

-- Owner credential and installation changes, without credentials.
CREATE TABLE owner_audit (
 id TEXT PRIMARY KEY NOT NULL,
 action TEXT NOT NULL CHECK (action IN ('setup_activated','password_changed','password_reset','origin_moved','limits_changed')),
 detail TEXT CHECK (detail IS NULL OR json_valid(detail)),
 created_at INTEGER NOT NULL
);
CREATE INDEX owner_audit_time ON owner_audit(created_at);
