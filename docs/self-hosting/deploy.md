# Deploy Flared on Cloudflare

This guide deploys one standalone Flared installation: one owner, one workspace, and one Worker.

## Before you start

- A Cloudflare account. Workers Free works; see [Workers Free or Workers Paid](#workers-free-or-workers-paid).
- A GitHub or GitLab account. Deploy on Cloudflare copies the latest release of this repository into it.
- A setup secret: any value of at least 16 characters. Keep it until you finish setup.

## Deploy

1. Open [Deploy on Cloudflare](https://deploy.workers.cloudflare.com/?url=https://github.com/FlaredLink/Flared).
2. Keep the Worker name `flared`, or choose another.
3. Enter your setup secret as `SETUP_SECRET`.
4. Start the deploy. Cloudflare creates the three D1 databases and the two Queues, applies the migrations, and deploys the Worker.

The Worker needs no other secret. It uses the address where you do the setup as the app address, and it makes its own key to sign sessions. To set them yourself, see `APP_ORIGIN` and `AUTH_SECRET` in `.dev.vars.example`.

## Set up the owner

1. Open the Worker address that Cloudflare shows after the deploy, such as `https://flared.YOUR-SUBDOMAIN.workers.dev`. It opens `/setup`. This address becomes the app address; to use your own domain for the app later, see [origin.md](origin.md).
2. Enter `SETUP_SECRET`, a username, a password of at least 12 characters, and a workspace name.
3. The wizard confirms the address, creates your first link, and waits until a click on it counts.

Setup never opens again after that, so `SETUP_SECRET` has no more use. You can keep or delete it.

If you lost `SETUP_SECRET` before setup, set a new value: **Workers & Pages → flared → Settings → Variables and Secrets**, edit `SETUP_SECRET`, save and deploy, then enter the new value at `/setup`. Cloudflare never shows a secret again after you save it.

Without email, only the Cloudflare account can reset a forgotten password. See [recovery.md](recovery.md).

## What runs

- The Worker serves the app, the API, OAuth, the MCP endpoint, and short links on one address.
- The Queue `flared-clicks` carries clicks to the analytics database. Clicks that fail five times go to `flared-clicks-dlq`.
- A cron every 10 minutes and a daily cron run maintenance. `https://<your app address>/healthz` answers 200 while the 10-minute cron runs; point an uptime monitor at it.

## Workers Free or Workers Paid

Flared runs on Workers Free. Workers Paid (US$5 a month) gives more room. On Free:

- The Worker answers 100,000 requests a day, app and short links together.
- D1 allows 5 million rows read and 100,000 rows written a day, and each database holds up to 500 MB. When the account reaches a daily D1 limit, Flared cannot read or write its databases until 00:00 UTC, so links and sign-in stop until then.
- Queues allow 10,000 operations a day. Each recorded click uses about three.
- Time Travel keeps 7 days of history; Workers Paid keeps 30. See [backups.md](backups.md).
- Cloudflare documents a limit of 10 ms of CPU time per request. The password hash is deliberate CPU work: a sign-in takes about 30 ms and setup about 160 ms. On 2026-10-08 both finished on a Free account. If Cloudflare stops such a request, it fails with error 1102, "Worker exceeded resource limits". Then move the account to Workers Paid; nothing else changes.

Next: [move the app to your own address](origin.md), [use your own domains for links](domains.md), [add members](members.md), [change the limits](limits.md), [upgrade](upgrade.md), and [back up](backups.md).
