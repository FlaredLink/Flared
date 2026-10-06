# @flaredlink/cli

Create, edit, and measure [Flared](https://flared.page) short links from your terminal. The installed command is `flared`. It needs Node.js 20 or later.

```sh
npm install -g @flaredlink/cli
flared login
flared link create https://example.com/launch --slug launch
flared analytics launch
```

Create an API token in the Flared app under Settings. `flared login` asks for it without showing it, checks it with the API, and saves it in `~/.config/flared/config.json` (or `$XDG_CONFIG_HOME/flared`; `%APPDATA%\flared` on Windows), readable only by you. In CI, set `FLARED_TOKEN` instead, or pipe the token to `flared login --token-stdin`.

## Commands

| Command                                                                                   | What it does                                                        |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `flared login [--token-stdin]`                                                            | Save an API token after the API accepts it.                         |
| `flared logout`                                                                           | Delete the saved token. Revoke it in Settings to stop it working.   |
| `flared whoami`                                                                           | Show the token, its scopes, and the API URL.                        |
| `flared link create URL [--slug S] [--title T] [--domain HOSTNAME] [--idempotency-key K]` | Create a link and print its short URL. Reuse a key to retry safely. |
| `flared link list [--search Q] [--limit N] [--cursor C] [--all]`                          | List links, newest first.                                           |
| `flared link get LINK`                                                                    | Show one link.                                                      |
| `flared link update LINK [--destination URL] [--title T \| --clear-title]`                | Change the destination or the title.                                |
| `flared link disable LINK`, `flared link enable LINK`                                     | Stop or restart redirects. A disabled link keeps its slug.          |
| `flared link qr LINK [--format svg\|png] [--out FILE]`                                    | Make a QR code. SVG goes to standard output without `--out`.        |
| `flared domain list`                                                                      | List domains, their status, and the DNS records to create.          |
| `flared domain add HOSTNAME`                                                              | Add a subdomain you own and print the CNAME record to create.       |
| `flared domain check DOMAIN`                                                              | Check the DNS record and the HTTPS certificate now.                 |
| `flared domain remove DOMAIN --yes`                                                       | Remove a domain. Its links stop redirecting until you add it again. |
| `flared analytics LINK [--from YYYY-MM-DD] [--to YYYY-MM-DD]`                             | Clicks by day, country, referrer, and device.                       |
| `flared usage`                                                                            | Usage against the workspace limits, with warnings.                  |

`LINK` is a link ID or a slug. `DOMAIN` is a domain hostname or ID. Every command accepts `--json` for machine-readable output and `--api-url URL`.

## Custom domains

Use a subdomain you own, such as `go.example.com`, for your short links:

```sh
flared domain add go.example.com
# Create the CNAME record it prints, then:
flared domain check go.example.com
flared link create https://example.com/launch --domain go.example.com
```

`domain add`, `check`, and `remove` need a token with the `domains:write` scope; `domain list` and `--domain` need `domains:read`. A domain serves links once its status is `active`. Without `--domain`, a link uses the default domain. `flared domain remove` tells you how many active links stop and needs `--yes` to go ahead. The links and their slugs stay reserved, so adding the domain again restores them.

`flared link qr` encodes the short URL: SVG by default, or a 512 × 512 PNG with `--format png --out FILE`.

## Self-hosted Flared

Point the CLI at your instance's API with `--api-url` or `FLARED_API_URL`, for example `https://links.example.com/v1`. `flared login --api-url URL` saves it with the token. HTTPS is required except on `localhost`.

## Exit codes

| Code | Meaning                                                     |
| ---- | ----------------------------------------------------------- |
| 0    | Success                                                     |
| 1    | Unexpected failure                                          |
| 2    | Wrong command usage                                         |
| 3    | Not signed in, or the token is invalid, expired, or revoked |
| 4    | Not allowed, for example a missing scope or a blocked link  |
| 5    | Not found                                                   |
| 6    | Rejected input or a conflict, such as a slug in use         |
| 7    | Plan limit reached                                          |
| 8    | Rate limited                                                |
| 9    | Service unavailable or no network                           |

With `--json`, errors go to standard error as `{ "error": { "code", "message", "requestId" } }`.

## License

AGPL-3.0-only. The source is in [FlaredLink/Flared](https://github.com/FlaredLink/Flared/tree/main/packages/cli).
