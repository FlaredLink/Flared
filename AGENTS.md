# Flared core contributor guide

This public repository contains the shared Flared implementation and is licensed AGPL-3.0-only. Keep it independently installable with Bun and strict TypeScript. Never import private cloud modules, credentials, or operating procedures. Identify new original source and manifests with AGPL-3.0-only.

Target Cloudflare Workers, with D1 for identity persistence. Use versioned additive migrations and parameterized SQL. Authentication/session changes require real Workers/D1 tests for concurrency, expiry, replay and failure behavior. Never weaken security assertions or replace persistence with mocks to obtain a passing test.

Before changing files, inspect git status. Preserve unrelated changes. Commit manifests and lockfile together. Run available type, format and critical test scripts, inspect their outputs, and run git diff --check. Do not claim unsupported or untested product features work.

Use Conventional Commits and repository-local identity PGHQdev <242389565+PGHQdev@users.noreply.github.com>. Publishing is a separate action governed by the owner's authorization.
