-- SPDX-License-Identifier: AGPL-3.0-only
-- Passkeys from Better Auth 1.7.6 @better-auth/passkey. Public-key credentials only; deleting a
-- user deletes their passkeys. A credential ID identifies one authenticator key, so it is unique.
CREATE TABLE "passkey" ("id" TEXT PRIMARY KEY NOT NULL, "name" TEXT, "publicKey" TEXT NOT NULL, "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE, "credentialID" TEXT NOT NULL UNIQUE, "counter" INTEGER NOT NULL, "deviceType" TEXT NOT NULL, "backedUp" INTEGER NOT NULL, "transports" TEXT, "createdAt" INTEGER, "aaguid" TEXT);
CREATE INDEX "passkey_userId_idx" ON "passkey"("userId");
