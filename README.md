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

- `@flared/contracts`: link input validation, stable error codes and the shared reserved-path list.
- `@flared/data`: identity, tenancy and routing tables, the D1/Drizzle adapter and versioned migrations.
- `@flared/server`: absolute session defaults, safe principal extraction, structured Cloudflare email delivery, trusted service forwarding, the `/v1` links API and the short-link redirect handler.
- `@flared/ui`: the link create form and link list.

Import declared subpath exports. Apply `packages/data/migrations/identity` to the identity database and `packages/data/migrations/routing` to the routing database through a migration runner; never modify a released migration. No analytics tables exist yet.

The redirect handler (`@flared/server/redirect`) accepts only GET and HEAD. It sends reserved paths to the configured app origin, answers unknown hosts and links with a generic 404, and keeps each resolved link in a Workers Cache entry for at most 60 seconds from the start of its database lookup. A database failure without a valid entry returns 503.

## Authentication integration

The current sign-in proof storage integration is pinned to Better Auth 1.7.6 with the Email OTP and Magic Link plugins. Run `bun run test:auth-probe` before changing its library, schema or runtime dependencies.

The unmodified library fails three tested D1 invariants: wrong-attempt restoration overlapping resend, expiry deletion overlapping resend, and rejection exactly at expiry. `installD1ProofGuards` fixes only the verification storage layer, using atomic D1 claims and generation-bound restoration. The library retains hashing, code/token verification, attempt policy, accounts and sessions.

Callers must:

1. Use the shared identity migration and adapter, without secondary storage, custom verification schema/identifier settings or verification hooks.
2. Construct only the trusted pinned sign-in OTP and magic-link plugins. Plugin initialization hooks are a trusted composer concern; they cannot all be introspected by the guard.
3. Await the auth instance's `$context`, then install guards before exposing any API.
4. Wrap each sign-in issuance/verification call in its own `withIdentityProofScope('issue' | 'verify', ...)`. Scope state is isolated across simultaneous calls, including calls sharing an instance.
5. Expose only intended sign-in server methods through validated routes. Do not mount the generic library HTTP handler or expose password reset, email change, other OTP types or unscoped proof operations.
6. Clean expired verification rows, including consumed tombstones, in bounded batches using an expiry predicate.

The harness uses `2026-08-22` and `nodejs_compat`; this is the latest compatibility date supported by the pinned test runtime. The guarded probe passes 16 tests. `FLARED_PROBE_BASELINE=1 bun run test:auth-probe` deliberately reproduces the three failures against unmodified storage and exits nonzero; it is diagnostic, not the passing CI command.

The cloud email-code/magic-link composition is maintained separately. The standalone username/password application and deployment setup remain planned; no email setup is required to run the core tests.

## License

Copyright (C) 2026 PGHQdev.

Flared core is open-source software licensed under the [GNU Affero General Public License, version 3 only](LICENSE.md) (SPDX: `AGPL-3.0-only`). This applies to this repository's original code and documentation unless a file states otherwise; third-party notices remain in effect.

You may use, study, modify, self-host, and redistribute the core, including commercially, subject to the license. If you modify it and let users interact with that version over a network, section 13 requires offering those users its Corresponding Source. Distribution also carries source and notice obligations. There is no warranty; see the license for the full terms.

The separately maintained Flared Cloud application is not included in this repository or licensed by this notice.
