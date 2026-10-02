-- SPDX-License-Identifier: AGPL-3.0-only
-- API tokens from Better Auth 1.7.6 @better-auth/api-key. "key" holds the SHA-256 hash of the
-- token, never the token. "referenceId" is the owning user; deleting the user deletes the
-- tokens. "metadata" holds the workspace the token is bound to, set only by the server.
CREATE TABLE "apikey" ("id" TEXT PRIMARY KEY NOT NULL, "configId" TEXT NOT NULL DEFAULT 'default', "name" TEXT, "start" TEXT, "referenceId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE, "prefix" TEXT, "key" TEXT NOT NULL UNIQUE, "refillInterval" INTEGER, "refillAmount" INTEGER, "lastRefillAt" INTEGER, "enabled" INTEGER DEFAULT 1, "rateLimitEnabled" INTEGER DEFAULT 1, "rateLimitTimeWindow" INTEGER DEFAULT 86400000, "rateLimitMax" INTEGER DEFAULT 10, "requestCount" INTEGER DEFAULT 0, "remaining" INTEGER, "lastRequest" INTEGER, "expiresAt" INTEGER, "createdAt" INTEGER NOT NULL, "updatedAt" INTEGER NOT NULL, "permissions" TEXT, "metadata" TEXT);
CREATE INDEX "apikey_configId_idx" ON "apikey"("configId");
CREATE INDEX "apikey_referenceId_idx" ON "apikey"("referenceId");
CREATE INDEX "apikey_expiresAt_idx" ON "apikey"("expiresAt") WHERE "expiresAt" IS NOT NULL;
-- At most 25 unexpired tokens per user. SQLite runs writes one at a time, so concurrent
-- creations cannot pass the count together.
CREATE TRIGGER "apikey_limit" BEFORE INSERT ON "apikey"
WHEN (SELECT count(*) FROM "apikey" WHERE "referenceId" = NEW."referenceId" AND ("expiresAt" IS NULL OR "expiresAt" > NEW."createdAt")) >= 25
BEGIN SELECT RAISE(ABORT, 'api_key_limit'); END;
