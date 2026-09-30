# Flared

Create, share, and measure links from your app, terminal, or AI agent. **Self-host or use our cloud.**

Flared is a link shortener with click analytics and QR codes, built for Cloudflare. This repository contains the public core for a complete single-workspace self-hosted installation. Flared Cloud builds on the same core.

## Status

Initial repository setup only. The application and deployment instructions are not implemented yet.

The planned core includes link management and redirects, analytics, QR downloads, a web dashboard, an API, a CLI, and a local MCP server. Development uses TypeScript and Bun; deployments target Cloudflare Workers.

## License

Copyright (C) 2026 PGHQdev.

Flared core is open-source software licensed under the
[GNU Affero General Public License, version 3 only](LICENSE.md)
(SPDX: `AGPL-3.0-only`). This applies to this repository's original code and
documentation unless a file states otherwise; third-party notices remain in effect.

You may use, study, modify, self-host, and redistribute the core, including
commercially, subject to the license. If you modify it and let users interact
with that version over a network, section 13 requires offering those users
its Corresponding Source. Distribution also carries source and notice obligations.
There is no warranty; see the license for the full terms.

The Flared core is open source. The separately maintained Flared Cloud application
is not included in this repository or licensed by this notice.
