# Flared

Create, share, and measure links from your app, terminal, or AI agent. **Self-host or use our cloud.**

This is the public Flared core. It provides shared identity schemas, session defaults, authentication proof storage guards, email delivery and service forwarding helpers. The complete self-hosted link application is still in development.

## Development

Use Bun 1.3.14. From a standalone checkout:

```sh
bun install --frozen-lockfile
bun run check
bun run test
bun run format:check
```

Tests run locally in Cloudflare's workerd runtime with real D1 storage. They require no Cloudflare account, email provider, or private repository. The test-only delivery capture is confined to `tests/`.

## Shared packages

- `@flared/contracts`: link input validation, stable error codes, API token scopes and responses (`@flared/contracts/tokens`), the shared reserved-path list, the passkey summary shown to account pages, and the click event and analytics response contracts (`@flared/contracts/analytics`).
- `@flared/data`: identity, tenancy, routing and analytics tables, the D1/Drizzle adapter and versioned migrations.
- `@flared/server`: absolute session defaults, safe principal extraction, structured Cloudflare email delivery, trusted service forwarding, the `/v1` links and analytics API, the short-link redirect handler, the click Queue consumer (`@flared/server/analytics`) and the analytics shard map (`@flared/server/shards`).
- `@flared/client`: the typed `/v1` client for the CLI and the MCP endpoint. It takes an API URL and a token, checks each response's shape, and throws `FlaredApiError` with the API error code. It retries only reads and keyed link creation, after 429, 503, or a network error.
- `@flaredlink/cli` (`packages/cli`): the published `flared` command for Node.js 20 or later. `bun run build:cli` bundles it into `packages/cli/dist/flared.js`; `bun run test:cli` runs its tests. See its [README](packages/cli/README.md).
- `@flared/ui`: the link create form and link list, the link analytics view, the usage warning banner and usage meters, the API token list (`@flared/ui/tokens/TokenList.svelte`), the passkey list, and the browser passkey ceremonies (`@flared/ui/passkeys/client`) against the shared `/api/auth/passkey/*` routes. It also has the connected-app list with its setup guide, the workspace rename form (`@flared/ui/workspace/WorkspaceName.svelte`), and the Light, Dark, and System control (`@flared/ui/theme/ThemeControl.svelte`). `@flared/ui/styles` holds the Kumo tokens (MIT), the Flared design roles in light and dark values, and element defaults; each app imports it once. The Claude, ChatGPT, and Cursor marks in `packages/ui/src/oauth/AssistantMark.svelte` come from LobeHub icons (MIT, `LOBEHUB-LICENSE.txt` beside it), and show only for an app whose redirect URIs belong to that assistant. The analytics view shows country flags from flag-icons 7.5.0 (MIT, `packages/ui/src/analytics/flags/LICENSE`), browser logos from alrra/browser-logos (MIT for the project; the logos are their owners' trademarks; `browsers/LICENSE.txt`), and device and OS icons from Phosphor (MIT, `PHOSPHOR-LICENSE.txt`). Flags and logos are separate files that load after the page mounts.

Import declared subpath exports. Apply `packages/data/migrations/identity` to the identity database, `packages/data/migrations/routing` to the routing database, and `packages/data/migrations/analytics` to every analytics shard through a migration runner; never modify a released migration.

The redirect handler (`@flared/server/redirect`) accepts only GET and HEAD. It sends reserved paths to the configured app origin, answers unknown hosts and links with a generic 404, and keeps each resolved link in a Workers Cache entry for at most 60 seconds from the start of its database lookup. A database failure without a valid entry returns 503.

## Click analytics

Given a `clicks` sink (a Queue producer), the redirect handler sends one event after each GET redirect of a link. HEAD requests, reserved paths, errors, and user agents that the versioned classifier in `@flared/server/clicks` marks as automated (crawlers, link-preview fetchers, HTTP libraries, empty user agents) send nothing. The event carries only the tenant, link, shard, time, a two-letter country, a device category, a browser family (Chrome, Safari, Firefox, Edge, Samsung Internet, Opera, other, or unknown), an OS family (iOS, Android, Windows, macOS, Linux, ChromeOS, other, or unknown), and the referrer host name. No browser or OS version and no user agent leave the redirect; in-app browsers count as other, and iPads that send a macOS user agent count as macOS. A failed send never changes the redirect.

`createClickConsumer({ shards })` is the Queue consumer. Each event is one D1 batch on the tenant's shard: a receipt per event ID with a fresh attempt token, admission against the calendar-month allowance in UTC, and the daily totals and the country, device, referrer, browser family, and OS family counts, each guarded in SQL by the admitted receipt of this attempt. A replay after a committed attempt changes nothing, and a failed batch rolls back completely. Invalid, test, and expired events (older than 48 hours) are acknowledged without counting. An event for an unbound shard or a tenant without a policy on its shard is retried; it never goes to another database. A link and day keep at most 50 referrer names; later ones count as `other`. An event without browser and OS fields (sent before analytics migration `0005_browser_os.sql`) counts with no browser or OS row, so those breakdowns can sum to less than the total.

A tenant becomes active when routing and its analytics shard both hold its policy (`projectPolicy`, `retryProjections`). `purgeExpired` removes aggregates past the tenant's retention and receipts after 72 hours. The API adds `GET /v1/links/:id/analytics` (UTC days, clamped to retention), `GET /v1/usage`, and `clicksLast30Days` on listed links.

## Operations

`@flared/server/operations` measures the installation for its operator; each edition sets its own thresholds and screens.

- The click consumer adds its counts for each UTC minute to `ingestion_minutes` on the event's shard (analytics migration `0004_ingestion_minutes.sql`): counted, duplicate, dropped, and retried events, the largest lag from click to count, and the newest click time. The counts are written after the events commit, so a failed write loses counts, never clicks. `readIngestion` sums a window for each shard; `purgeExpired` removes minutes after 14 days. A shard without clicks has no recent minute, which alone does not mean the Queue is stuck.
- `measureShards` records the size of each bound shard and its workspace count in `analytics_shard_samples` (identity migration `0010_operations.sql`). D1 returns the database size with each query result, so no account credentials are needed. `readShardProjections` projects each shard's size from its growth over a window; the edition chooses the window, the horizon, and the limits. Run it about once an hour.
- `createDeadLetterConsumer` consumes the click dead-letter queue. It stores the validated event, or only the message ID for an invalid body, in `dead_letters`. `requeueDeadLetter` sends one stored event back to the click Queue; event deduplication keeps a counted click from counting twice, and an event older than 48 hours is not sent. `purgeOperations` removes samples after 90 days and dead letters after 7 days.

## Export

`GET /v1/export/links` (`links:read`), `GET /v1/export/daily-totals`, and `GET /v1/export/daily-dimensions` (`analytics:read`) return a workspace in pages: every link, active and disabled, and the daily totals and breakdowns within the retention window, in key order. Follow `nextCursor` until it is null. `writeExport` (`@flared/client/export`) writes the pages as one JSON document with the format `flared.export/1`, and `linksCsv` writes the links as CSV. `flared export --out FILE` uses them. No export file is stored on the server.

## Workspace deletion

`requestDeletion` (`@flared/server/deletion`) starts deleting the user's workspace. In one batch it records a `tenant_deletions` job and deletes the user's sessions, API tokens, and connected-app grants. The application checks the session, a recent sign-in, and the typed confirmation first. From then on the API answers 409 `ACCOUNT_DELETING`, no store receives the tenant's policy again, and `@flared/ui/account/DeleteAccount.svelte` provides the confirmation form.

`runDeletions` runs the job in resumable steps: the acceptance email, the end of the routing policy and every workspace domain (redirects stop), a 70-second wait past the redirect snapshots, an analytics tombstone and the shard rows, the links and request records, an optional `extension` for an edition's own records, and the identity records with the user. A completion email ends the job, and the contact address goes with it. Each email is sent at most once. Run `runDeletions` every few minutes and right after a request; a failed step waits 1, 2, 4, ... minutes. Late clicks for a tombstoned tenant are dropped. Slug reservations, hostname namespaces, and disabled domain rows stay, so no address is reused. `cleanupDeletions` removes the completed ledger after 90 days, and `purgeExpired` removes tombstones after 90 days. Deleting the workspace of a single-workspace installation closes it for good.

## Abuse blocks and suspensions

`@flared/server/operator` holds the operator's abuse actions. They act across tenants, so only an operator composition calls them; the caller authenticates the operator and keeps the audit record. Each action takes an `OperatorPrincipal` for its log line and is safe to repeat.

- `blockLink` and `unblockLink` set `links.blocked_at` and an abuse category (routing migration `0004_operator_blocks.sql`). A blocked link answers 410 with a static blocked page, which links to `reportUrl` when the redirect handler has one. A block reaches every visitor within the 60-second snapshot bound; a cleared block takes effect on the next request. A block never changes the owner's on/off status: the owner can turn a blocked link off, but cannot edit it or turn it on (409 `LINK_BLOCKED`). The API returns the block as `blocked: { reason }` on each link.
- `suspendTenant` and `reinstateTenant` set `tenant_policy.suspended_at` in identity (migration `0009_tenant_suspension.sql`) as the next policy revision. The routing projection carries it, so every link of the tenant stops; if the projection fails, `retryProjections` completes it. A plan change keeps the suspension, and a reinstatement keeps each link block. While suspended, the API answers 403 `WORKSPACE_SUSPENDED` to every change; a session can still read, and end a token or connected app, and a token or connected app can only call `/v1/export/*` and `/v1/me`. The MCP endpoint refuses calls, and no new app can connect. `requestDeletion` answers `suspended` and changes nothing until the tenant is reinstated; the job insert checks the suspension again in its batch, and a running deletion cannot be suspended.
- `revokeCustomerAccess` deletes the sessions, API tokens, and connected-app grants of the tenant's members.

## Limits, usage, and notices

`updatePolicy` (`@flared/server/tenancy`) stores new limits as the next policy revision and projects them to routing and the tenant's analytics shard. A failed projection returns `projected: false`, and `retryProjections` finishes it later. Lower limits never disable existing links or domains; they block new ones. A self-hosted operator changes limits this way.

A click that arrives after the monthly allowance is full still redirects and is not recorded. The shard counts it as missing, with the time of the first one. `GET /v1/usage` returns recorded clicks, missing clicks and since when, active links, custom domains, days of history, and a warning for each limit at 80% or 100%. `flared usage`, the MCP `get_usage` tool, `@flared/ui/usage/UsageBanner.svelte`, and `@flared/ui/usage/UsageMeters.svelte` show the same data.

Notices to the workspace owner use the identity `notices` outbox (`@flared/server/notices`). `reconcileClickNotices` records click warnings from each shard; run it every few minutes. The API records link and domain warnings after a creation, and `reconcileLimitNotices` catches the rest once a day, including after a lowered limit. Each notice has a dedupe key, so it happens once per threshold and month, or per threshold and policy revision. `dispatchNotices` emails pending notices to the owner's verified address through an `EmailTransport` and a template such as `usageNoticeEmail`. A failed send becomes `delivery_unknown` and is never resent. Without email, notices stay pending and the dashboard warning still shows. `cleanupNotices` deletes notices after 62 days.

## API tokens

`@flared/server/auth/api-tokens` wraps the Better Auth API-key plugin (`createApiTokenPlugin`). Tokens start with `flr_`, are stored only as a SHA-256 hash, are bound to one workspace, and allow 60 requests per minute. A user has at most 25 unexpired tokens (identity migration `0005`). Never mount the plugin's `/api/auth/api-key/*` endpoints; create tokens only through the API.

`createApi` takes an `authenticate` function that returns a session or token principal. `authenticateBearer` reads `Authorization: Bearer <token>` and ignores cookies. A session holds every scope; a token needs the route's scope (`links:read`, `links:write`, `analytics:read`, `domains:read`, `domains:write`, `usage:read`), else 403 `INSUFFICIENT_SCOPE`. Session writes need the exact app origin; token requests do not. `GET /v1/me` describes the calling credential and needs no scope. With `publicApiUrl`, `GET /v1/openapi.json` serves the OpenAPI 3.1 description (`@flared/contracts/openapi`) without a credential; tests check it against the routes and every response of the client tests. `GET`, `POST /v1/tokens` and `DELETE /v1/tokens/:id` accept sessions only. Creation needs a sign-in from the last 10 minutes (403 `REAUTH_REQUIRED`) and returns the secret once.

## Domains and QR codes

`GET /v1/links/:id/qr` returns an SVG or PNG QR code of the short URL (`format`, `size` 128–2048, `download=1`), encoded by `@flared/client/qr` with `lean-qr`; the CLI uses the same encoder.

`createApi` takes optional `domains: { provider, reservedHostnames }`. A workspace adds a subdomain with `POST /v1/domains` within its `domain_limit`; `GET /v1/domains` lists active platform domains and the workspace's own. A `DomainProvider` (`@flared/server/domains`) attaches hostnames and returns evidence (`waiting`, `verifying`, `ready`, or `failed` with a code); only that evidence changes a domain's state, and only an active domain serves links. Without a provider, domains are listed and adding one answers 503 `DOMAINS_UNAVAILABLE`. An unverified claim expires after 7 days; removal stops the domain's links and keeps their slug reservations. `recordDomainEvidence` stores evidence from an edition's scheduled checks.

## Connected apps: OAuth and MCP

AI assistants such as ChatGPT, Claude, and Grok connect to a remote MCP endpoint, for example `https://api.flared.page/mcp`. The endpoint is an OAuth 2.1 resource server; it accepts no API tokens and no cookies.

- `@flared/server/oauth/provider`: `createOAuthServer(db, config)` composes `@better-auth/oauth-provider` 1.7.7 with `@better-auth/mcp` and `@better-auth/cimd` on a separate Better Auth instance. The sign-in proof guards refuse these plugins, so never add them to the sign-in instance. The issuer is the app origin and the endpoints live at its root. It supports the authorization code grant with PKCE `S256` only, RFC 8707 resource binding, RFC 9207 `iss` in every authorization response, refresh tokens rotated on each use (a retry within 30 seconds receives the same response; reuse after that revokes the client's tokens for the user), and RFC 7009 revocation. Access tokens (`flo_at_`) live 1 hour and refresh tokens (`flo_rt_`) 30 days; both are opaque and stored as SHA-256 hashes. The grant records the signed-in user's workspace. Pass `createMetadataFetch()` as `fetchClientMetadata`: it fetches client ID metadata documents over HTTPS and refuses redirects. On Cloudflare, also set the `global_fetch_strictly_public` compatibility flag.
- `@flared/server/oauth`: `createOAuthRoutes` serves the only routes that reach the provider: `/.well-known/oauth-authorization-server`, `/oauth2/authorize`, `/oauth2/token`, `/oauth2/register`, `/oauth2/revoke`, `/oauth2/consent` (POST, session cookie, exact app origin), and `/oauth2/consent/request` (what the consent page shows). Every authorization shows the consent page, also for an app approved before. `prompt`, `max_age`, request objects, and DPoP are not supported. Open client registration needs a `sourceKey` for the request and allows 10 registrations per source and 500 in total per hour. The application serves the sign-in page (`loginPath`) and the consent page (`consentPath`). After sign-in, send the browser to `resumeAuthorizationPath(query)` from `@flared/contracts/oauth`. The consent page also shows errors from the provider as `error` and `error_description` query parameters.
- `@flared/server/mcp`: `createMcpEndpoint` checks a present `Origin` against the allowed list, the bearer token, its audience (the endpoint URL), the consent, and the workspace membership on every request. It answers 401 with `WWW-Authenticate: Bearer resource_metadata="…"` and 403 `insufficient_scope` naming the scopes that a tool call needs. It allows 60 calls per minute for each app and user. The tools are `list_links`, `get_link`, `get_link_analytics`, `get_usage`, `create_link`, `update_link`, `disable_link`, and `enable_link`; they call `createApi` in process with an `oauth` principal. `mcpServerCard` builds a draft SEP-1649 server card for `/.well-known/mcp/server-card.json`. `protectedResourceMetadata` builds the RFC 9728 document to serve at `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp` on the endpoint host. The endpoint serves protocol 2026-07-28 in JSON mode and 2025-era clients statelessly.
- `GET /v1/connected-apps` and `DELETE /v1/connected-apps/:clientId` list and revoke apps for a session. Revocation deletes the consent and every token of the app in the workspace; the next MCP call fails. `deleteExpiredOAuthRecords` removes expired tokens and clients without a consent a week after registration.

Identity migration `0006_oauth.sql` adds the provider tables and the request counters. `tests/oauth.test.ts` covers the flow under workerd and D1, including concurrent code redemption and refresh, refresh reuse, PKCE, redirect and resource checks, client ID metadata documents, revocation during a refresh, membership loss, scope challenges, and every tool.

## Authentication integration

The current sign-in proof storage integration is pinned to Better Auth 1.7.7 with the Email OTP and Magic Link plugins. Run `bun run test:auth-probe` before changing its library, schema or runtime dependencies.

The unmodified library fails three tested D1 invariants: wrong-attempt restoration overlapping resend, expiry deletion overlapping resend, and rejection exactly at expiry. `installD1ProofGuards` fixes only the verification storage layer, using atomic D1 claims and generation-bound restoration. The library retains hashing, code/token verification, attempt policy, accounts and sessions.

Callers must:

1. Use the shared identity migration and adapter, without secondary storage, custom verification schema/identifier settings or verification hooks.
2. Construct only the trusted pinned sign-in OTP, magic-link, username, and passkey plugins; build the passkey plugin with `createPasskeyPlugin` from `@flared/server/auth/passkey`. Plugin initialization hooks are a trusted composer concern; they cannot all be introspected by the guard.
3. Await the auth instance's `$context`, then install guards before exposing any API.
4. Wrap each sign-in issuance/verification call in its own `withIdentityProofScope('issue' | 'verify', ...)`. Passkey options calls issue a challenge; passkey verification calls consume it. Scope state is isolated across simultaneous calls, including calls sharing an instance.
5. Expose only intended sign-in server methods through validated routes. Do not mount the generic library HTTP handler or expose password reset, email change, other OTP types or unscoped proof operations.
6. Clean expired verification rows, including consumed tombstones, in bounded batches using an expiry predicate.

## Edition composition

Each edition composes these shared modules in its own Worker and keeps only its sign-in method and policy.

- `@flared/server/auth/routes`: `createAuthRoutes` serves `/api/auth/session`, sign-out, passkey sign-in, passkey registration, listing, renaming, deletion, and passkey reauthentication. The edition passes its sign-in routes and their methods, its auth instance, the app origin, and the table of passkey attempts (`@flared/server/auth/limits`). Every other path answers 404. Every POST needs the exact app `Origin`, JSON, and at most 4 KB.
- `@flared/server/web/auth` and `@flared/server/web/api`: the application side. `forwardAuthRoute` forwards a browser request with a fixed set of headers and the trusted client address; `getAuthState`, `getPasskeys`, and the API readers serve server-rendered pages.
- `@flared/server/api/compose`: `apiAuthenticator` reads only the session cookie for the app's same-origin API, and only `Authorization: Bearer` for the token API.
- `@flared/server/oauth/handler`: the authorization server routes, the MCP endpoint, the protected resource metadata, the MCP server card, and the AI catalog, with the MCP resource URL from deployment configuration.
- `@flared/server/account`: `POST /api/account/delete`. The edition names the confirmation value and may refuse a deletion for its own reasons.
- `@flared/server/jobs`: `createJobLedger` records the outcome of each scheduled job in the edition's table.

A table name that an edition passes goes into SQL text, so it must match `^[a-z][a-z0-9_]{0,62}$`. `tests/shared-routes.test.ts` covers these modules under workerd and D1.

## Passkeys

`createPasskeyPlugin(origin, rpName)` pins `@better-auth/passkey` 1.7.7 to the configured app origin and its host as the relying party. It requires a discoverable credential and user verification. The library itself skips the user-verification check, so the plugin's hooks refuse a ceremony without it before anything is stored. Registration needs a session created in the last 10 minutes (`freshAge`). Library deletion needs only a session, so the composing application must check freshness before it deletes a passkey. `confirmWithPasskey` in `@flared/ui/passkeys/client` posts to `/api/auth/reauth/passkey/options` and `/verify`. The library signs in whoever owns the passkey, so `createAuthRoutes` refuses a passkey that does not belong to the signed-in user before verification. Identity migration `0003_passkey.sql` adds the `passkey` table; deleting a user deletes their passkeys.

`tests/passkey-probe.test.ts` proves the plugin under workerd and D1 with a software authenticator: single-use challenges under concurrent verification, replay refusal, wrong origin and relying party, missing user verification, ownership on rename and delete, immediate effect of deletion, and the seven-day session. The library answers a registration with a wrong origin or relying party with 500, not 400.

The harness uses `2026-08-22` and `nodejs_compat`; this is the latest compatibility date supported by the pinned test runtime. The guarded probe passes 16 tests. `FLARED_PROBE_BASELINE=1 bun run test:auth-probe` deliberately reproduces the three failures against unmodified storage and exits nonzero; it is diagnostic, not the passing CI command.

The cloud email-code/magic-link composition is maintained separately. No email setup is required to run the core tests.

## Standalone owner and setup

A standalone installation has one owner who signs in with a username and password; no email, OAuth application, or Flared service is involved. `apps/standalone` composes these modules (see [Standalone app](#standalone-app)).

- `@flared/server/auth/owner`: `createOwnerAuth` builds Better Auth 1.7.7 with the username plugin and the shared passkey plugin. Email sign-up, sign-in, and reset stay off. The owner's email is the internal address `<user id>@owner.invalid`; it is never verified, shown, or sent to. `createOwnerAuthRoutes` adds `POST /api/auth/sign-in/password`, `/api/auth/reauth/password`, and `/api/auth/password/change` to the shared routes. Passwords have 12 to 128 characters. Every credential failure answers 401 `INVALID_CREDENTIALS`.
- `@flared/server/auth/attempts`: each password route and setup reserves its budget in `auth_attempts` with one conditional insert before any hash runs. Sign-in allows 10 attempts per source in 15 minutes and 100 in total per hour; reauthentication and password change 5 per user in 15 minutes; setup 5 per source in 15 minutes and 30 in total per hour.
- Reauthentication takes only the password; the username comes from the session, so it cannot switch users. A password change needs a fresh sign-in and the current password, checked before the new one is hashed. It then ends every session of the owner and signs in again.
- `IdentityRule`: every session reader passes its edition's rule. The cloud needs a verified email. Standalone needs a username with a password account.
- `@flared/server/setup`: `POST /api/setup` takes the `SETUP_SECRET`, a username, a password, and a workspace name. It needs the exact app origin, JSON of at most 4 KB, the setup budget, and a secret of at least 32 bytes that differs from the auth secret; it compares the secret in constant time. The first proven request claims the installation in one batch with every value fixed. A retry with the secret, the same username, and the same password resumes the claim; anything else answers 409. The steps create the owner, the workspace, the app host as the default platform domain, and the policy projections; each step advances in the same batch as its records. Activation clears the stored hash. Setup never opens again after activation or deletion, whether or not the secret remains configured.
- `fixedTenantId` on `createApi`, `createRedirectHandler`, and `createClickConsumer` refuses any other tenant in a single-workspace installation, in addition to the database's one-tenant guard.

Identity migration `0011_standalone.sql` adds the username columns, a unique password account per user, `installation_setup`, `auth_attempts`, `passkey_attempts`, `job_runs`, and `owner_audit`. The shared Drizzle schema writes the username columns on every new user, so apply this migration before running code that includes it. `tests/standalone.test.ts` covers setup claims and resumes under concurrency, the closed states, username sign-in outside any proof scope, the budgets, reauthentication, password change with a failed later step, the identity rules, OAuth consent, and the single-workspace binding.

## Standalone app

`apps/standalone` is one Worker for a self-hosted installation: the SvelteKit app, the API, auth, OAuth, MCP, short-link redirects, the click Queue consumer, and the scheduled jobs. The root `wrangler.jsonc` configures it, so the repository root is the deployable unit. Its D1 bindings are `IDENTITY`, `ROUTING`, and `ANALYTICS_1`; the Queue is `flared-clicks` with the dead-letter queue `flared-clicks-dlq`. The secrets are in `.dev.vars.example`: `APP_ORIGIN`, `AUTH_SECRET`, and `SETUP_SECRET`. `SOURCE_URL` sets the source code link in the footer; it defaults to this repository.

- **Configuration.** Without a valid `APP_ORIGIN` (an `https:` origin with no path) or `AUTH_SECRET`, every request gets an operator page that names the missing secret. The page suggests the address it was reached on and stores nothing.
- **Hosts.** The `APP_ORIGIN` host serves the reserved paths: `/app`, `/setup`, `/api/*`, `/v1/*`, `/oauth2/*`, `/mcp`, `/healthz`, and `/.well-known/*`. Every other path on it, and every path on any other host, is a short link. Another host never serves an auth route, a cookie, or an app page.
- **Credentials.** `/api/v1/*` takes only the session cookie and the exact `Origin`; `/v1/*` takes only a bearer token; `/mcp` takes only an OAuth access token. A client address comes only from `cf-connecting-ip`.
- **Setup gate.** Until setup finishes, the app host serves only `/setup`, `POST /api/setup`, their assets, and `/healthz`. After the owner deletes the workspace, the installation is closed: the API answers 410, pages say so, and no link opens.
- **Moving the app host.** After `APP_ORIGIN` changes, the new host serves only sign-in until the owner signs in with the password there. That sign-in ends every session, OAuth grant, and passkey of the old origin in one batch and keeps API tokens. The old host keeps its short links.
- **Limits.** Settings changes the workspace limits with a fresh sign-in through `/api/settings/limits`. The first limits are 10,000 active links, 50,000 recorded clicks a month, 30 days of history, and 5 own domains; they are provisional until measured.
- **Jobs.** The 10-minute cron retries policy projections, runs deletions, records click notices, and samples the analytics database size. The daily cron cleans up auth records, link creation keys, expired analytics, limit notices, deletions, and operations records. Each job records its outcome in `job_runs`; `/healthz` answers 200 while the 10-minute run finished in the last 30 minutes.

Scripts: `bun run build` builds the app, `bun run build:dry-run` also checks the Worker bundle, `bun run test:standalone` runs the Worker tests under workerd and D1, and `bun run dev` runs it locally with `.dev.vars`. `bun run deploy` applies the three migration sets to the remote databases, then deploys.

`bun run owner:reset-password` resets a forgotten owner password through the operator's Wrangler login; see [docs/self-hosting/recovery.md](docs/self-hosting/recovery.md). The self-hosting guides are in [docs/self-hosting](docs/self-hosting/deploy.md).

Not yet available: own domains for short links, and a labeled test click (the setup wizard counts the owner's first real click instead). Deploy on Cloudflare is not verified on a clean account yet.

## License

Copyright (C) 2026 PGHQdev.

Flared core is open-source software licensed under the [GNU Affero General Public License, version 3 only](LICENSE.md) (SPDX: `AGPL-3.0-only`). This applies to this repository's original code and documentation unless a file states otherwise; third-party notices remain in effect.

You may use, study, modify, self-host, and redistribute the core, including commercially, subject to the license. If you modify it and let users interact with that version over a network, section 13 requires offering those users its Corresponding Source. Distribution also carries source and notice obligations. There is no warranty; see the license for the full terms.

The separately maintained Flared Cloud application is not included in this repository or licensed by this notice.
