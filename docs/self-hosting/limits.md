# Limits

The owner changes the workspace limits in **Settings → Limits and usage**. A change needs a sign-in from the last 10 minutes.

| Limit | First value | Range |
| --- | --- | --- |
| Active links | 10,000 | 1 to 1,000,000 |
| Recorded clicks a month | 50,000 | 1 to 100,000,000 |
| Days of click history | 30 | 1 to 3,650 |
| Own domains | 5 | 0 to 50 |

A lower limit never stops existing links or domains; it blocks new ones. A click past the monthly limit still redirects, but it is not recorded.

The first values are provisional until they are measured on a clean account. They aim to stay inside the daily allowances of Workers Free: 50,000 recorded clicks a month is about 1,700 a day, which uses about 5,000 of the 10,000 Queue operations a day. Higher limits use more D1 rows, D1 storage, and Queue operations; on Workers Free they can reach a daily limit, and on Workers Paid Cloudflare bills past the included amounts. Settings shows the size of the analytics database. One D1 database holds up to 500 MB on Workers Free and 10 GB on Workers Paid. See [Workers Free or Workers Paid](deploy.md#workers-free-or-workers-paid).
