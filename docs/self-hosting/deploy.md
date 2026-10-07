# Deploy Flared on Cloudflare

This guide deploys one standalone Flared installation: one owner, one workspace, and one Worker.

## Before you start

- A Cloudflare account on **Workers Paid** (US$5 a month).
- A GitHub or GitLab account. Deploy on Cloudflare copies this repository into it.
- Two random secrets. Generate them at [flared.page/secrets](https://flared.page/secrets), which makes them in your browser, or run `openssl rand -base64 48` once for each. Keep them different.

## Deploy

1. Open [Deploy on Cloudflare](https://deploy.workers.cloudflare.com/?url=https://github.com/FlaredLink/Flared).
2. Keep the Worker name `flared`, or note the name you choose.
3. Enter the secrets:
   - `APP_ORIGIN`: `https://flared.<your-account-subdomain>.workers.dev`. Use your Worker name if you changed it. Use `https://` and no path. You can also leave it empty and set it after the first deploy.
   - `AUTH_SECRET`: the first random secret.
   - `SETUP_SECRET`: the second random secret.
4. Start the deploy. Cloudflare creates the three D1 databases and the two Queues, applies the migrations, and deploys the Worker.

If you left `APP_ORIGIN` empty, open the Worker's address. The page tells you the value to set. Add it in **Workers & Pages → flared → Settings → Variables and Secrets** as a secret, then deploy again.

## Set up the owner

1. Open `https://<your app address>/setup`.
2. Enter `SETUP_SECRET`, a username, a password of at least 12 characters, and a workspace name.
3. The wizard confirms the address, creates your first link, and waits until a click on it counts.
4. Delete the `SETUP_SECRET` secret from the Worker. Setup never opens again, with or without it.

Without email, only the Cloudflare account can reset a forgotten password. See [recovery.md](recovery.md).

## What runs

- The Worker serves the app, the API, OAuth, the MCP endpoint, and short links on one address.
- The Queue `flared-clicks` carries clicks to the analytics database. Clicks that fail five times go to `flared-clicks-dlq`.
- A cron every 10 minutes and a daily cron run maintenance. `https://<your app address>/healthz` answers 200 while the 10-minute cron runs; point an uptime monitor at it.

Next: [move the app to your own address](origin.md), [change the limits](limits.md), [upgrade](upgrade.md), and [back up](backups.md).
