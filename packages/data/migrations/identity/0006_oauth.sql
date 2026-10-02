-- SPDX-License-Identifier: AGPL-3.0-only
-- OAuth 2.1 authorization server tables from Better Auth 1.7.7 @better-auth/oauth-provider with
-- @better-auth/mcp and @better-auth/cimd. Access and refresh tokens hold the SHA-256 hash of the
-- token, never the token. Deleting a user or a client deletes its consents and tokens.
CREATE TABLE "oauthClient" ("id" TEXT PRIMARY KEY NOT NULL, "clientId" TEXT NOT NULL UNIQUE, "clientSecret" TEXT, "clientDiscoveryId" TEXT, "disabled" INTEGER DEFAULT 0, "skipConsent" INTEGER, "enableEndSession" INTEGER, "subjectType" TEXT, "scopes" TEXT, "clientCredentialsScopes" TEXT, "userId" TEXT REFERENCES "user"("id") ON DELETE CASCADE, "createdAt" INTEGER, "updatedAt" INTEGER, "name" TEXT, "uri" TEXT, "icon" TEXT, "contacts" TEXT, "tos" TEXT, "policy" TEXT, "softwareId" TEXT, "softwareVersion" TEXT, "softwareStatement" TEXT, "redirectUris" TEXT NOT NULL, "postLogoutRedirectUris" TEXT, "backchannelLogoutUri" TEXT, "backchannelLogoutSessionRequired" INTEGER, "tokenEndpointAuthMethod" TEXT, "applicationType" TEXT, "jwks" TEXT, "jwksUri" TEXT, "grantTypes" TEXT, "responseTypes" TEXT, "requirePKCE" INTEGER, "dpopBoundAccessTokens" INTEGER DEFAULT 0, "referenceId" TEXT, "metadata" TEXT);
CREATE INDEX "oauthClient_userId_idx" ON "oauthClient"("userId");
CREATE INDEX "oauthClient_createdAt_idx" ON "oauthClient"("createdAt") WHERE "clientDiscoveryId" IS NULL;
CREATE TABLE "oauthResource" ("id" TEXT PRIMARY KEY NOT NULL, "identifier" TEXT NOT NULL UNIQUE, "name" TEXT NOT NULL, "accessTokenTtl" INTEGER, "refreshTokenTtl" INTEGER, "signingAlgorithm" TEXT, "signingKeyId" TEXT, "allowedScopes" TEXT, "customClaims" TEXT, "dpopBoundAccessTokensRequired" INTEGER DEFAULT 0, "disabled" INTEGER DEFAULT 0, "createdAt" INTEGER, "updatedAt" INTEGER, "policyVersion" INTEGER DEFAULT 1, "metadata" TEXT);
CREATE TABLE "oauthClientResource" ("id" TEXT PRIMARY KEY NOT NULL, "clientId" TEXT NOT NULL REFERENCES "oauthClient"("clientId") ON DELETE CASCADE, "resourceId" TEXT NOT NULL REFERENCES "oauthResource"("identifier") ON DELETE CASCADE, "metadata" TEXT, "createdAt" INTEGER);
CREATE INDEX "oauthClientResource_clientId_idx" ON "oauthClientResource"("clientId");
CREATE INDEX "oauthClientResource_resourceId_idx" ON "oauthClientResource"("resourceId");
CREATE TABLE "oauthRefreshToken" ("id" TEXT PRIMARY KEY NOT NULL, "token" TEXT NOT NULL UNIQUE, "clientId" TEXT NOT NULL REFERENCES "oauthClient"("clientId") ON DELETE CASCADE, "sessionId" TEXT REFERENCES "session"("id") ON DELETE SET NULL, "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE, "referenceId" TEXT, "authorizationCodeId" TEXT, "resources" TEXT, "requestedUserInfoClaims" TEXT, "expiresAt" INTEGER, "createdAt" INTEGER, "revoked" INTEGER, "rotatedAt" INTEGER, "rotationReplayResponse" TEXT, "rotationReplayExpiresAt" INTEGER, "authTime" INTEGER, "confirmation" TEXT, "scopes" TEXT NOT NULL);
CREATE INDEX "oauthRefreshToken_clientId_idx" ON "oauthRefreshToken"("clientId");
CREATE INDEX "oauthRefreshToken_sessionId_idx" ON "oauthRefreshToken"("sessionId");
CREATE INDEX "oauthRefreshToken_userId_idx" ON "oauthRefreshToken"("userId");
CREATE INDEX "oauthRefreshToken_authorizationCodeId_idx" ON "oauthRefreshToken"("authorizationCodeId");
CREATE INDEX "oauthRefreshToken_expiresAt_idx" ON "oauthRefreshToken"("expiresAt");
CREATE TABLE "oauthAccessToken" ("id" TEXT PRIMARY KEY NOT NULL, "token" TEXT UNIQUE, "clientId" TEXT NOT NULL REFERENCES "oauthClient"("clientId") ON DELETE CASCADE, "sessionId" TEXT REFERENCES "session"("id") ON DELETE SET NULL, "userId" TEXT REFERENCES "user"("id") ON DELETE CASCADE, "referenceId" TEXT, "authorizationCodeId" TEXT, "resources" TEXT, "requestedUserInfoClaims" TEXT, "refreshId" TEXT REFERENCES "oauthRefreshToken"("id") ON DELETE CASCADE, "expiresAt" INTEGER, "createdAt" INTEGER, "revoked" INTEGER, "confirmation" TEXT, "scopes" TEXT NOT NULL);
CREATE INDEX "oauthAccessToken_clientId_idx" ON "oauthAccessToken"("clientId");
CREATE INDEX "oauthAccessToken_sessionId_idx" ON "oauthAccessToken"("sessionId");
CREATE INDEX "oauthAccessToken_userId_idx" ON "oauthAccessToken"("userId");
CREATE INDEX "oauthAccessToken_authorizationCodeId_idx" ON "oauthAccessToken"("authorizationCodeId");
CREATE INDEX "oauthAccessToken_refreshId_idx" ON "oauthAccessToken"("refreshId");
CREATE INDEX "oauthAccessToken_expiresAt_idx" ON "oauthAccessToken"("expiresAt");
CREATE TABLE "oauthConsent" ("id" TEXT PRIMARY KEY NOT NULL, "clientId" TEXT NOT NULL REFERENCES "oauthClient"("clientId") ON DELETE CASCADE, "userId" TEXT REFERENCES "user"("id") ON DELETE CASCADE, "referenceId" TEXT, "resources" TEXT, "requestedUserInfoClaims" TEXT, "scopes" TEXT NOT NULL, "createdAt" INTEGER, "updatedAt" INTEGER);
CREATE INDEX "oauthConsent_clientId_idx" ON "oauthConsent"("clientId");
CREATE INDEX "oauthConsent_userId_idx" ON "oauthConsent"("userId");
CREATE TABLE "oauthClientAssertion" ("id" TEXT PRIMARY KEY NOT NULL, "expiresAt" INTEGER NOT NULL);
CREATE INDEX "oauthClientAssertion_expiresAt_idx" ON "oauthClientAssertion"("expiresAt");

-- Open dynamic client registration, counted per hashed source and hour.
CREATE TABLE oauth_registration_windows (
 source_key TEXT NOT NULL,
 window_start INTEGER NOT NULL,
 count INTEGER NOT NULL,
 PRIMARY KEY (source_key, window_start)
);
-- MCP tool calls, counted per grant (client and user) and minute.
CREATE TABLE mcp_call_windows (
 grant_key TEXT NOT NULL,
 window_start INTEGER NOT NULL,
 count INTEGER NOT NULL,
 PRIMARY KEY (grant_key, window_start)
);
