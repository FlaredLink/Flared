# Limits

The owner changes the workspace limits in **Settings → Limits and usage**. A change needs a sign-in from the last 10 minutes.

| Limit | First value | Range |
| --- | --- | --- |
| Active links | 10,000 | 1 to 1,000,000 |
| Recorded clicks a month | 50,000 | 1 to 100,000,000 |
| Days of click history | 30 | 1 to 3,650 |
| Own domains | 5 | 0 to 50 |

A lower limit never stops existing links or domains; it blocks new ones. A click past the monthly limit still redirects, but it is not recorded.

The first values fit the daily allowances of Workers Free: 50,000 recorded clicks a month is about 1,700 a day. Higher limits use more D1 rows, D1 storage, and Queue operations; on Workers Free they can reach a daily limit, and on Workers Paid Cloudflare bills past the included amounts. Settings shows the size of the analytics database. One D1 database holds up to 500 MB on Workers Free and 10 GB on Workers Paid. See [Workers Free or Workers Paid](deploy.md#workers-free-or-workers-paid).

## Measured on Workers Free

Measured on 2026-10-08 on a new Workers Free account, with one workspace and one link. The numbers come from a small sample, so treat them as a guide.

| Work | CPU time |
| --- | --- |
| Redirect | median 5 ms, highest 34 ms (28 requests) |
| Click Queue, a batch of up to 5 clicks | median 8 ms, highest 14 ms (5 batches) |
| 10-minute cron | 4 to 7 ms |
| Password sign-in | 30 ms; 50 ms for an unknown username |
| Setup | 157 ms (once) |
| An app page | 10 to 18 ms |

- A recorded click writes about 8 D1 rows, all in the analytics database: 180 rows for 22 clicks.
- Cloudflare counts 3 Queue operations for each click: write, read, and delete.

On Workers Free, the Queue allows about 3,300 recorded clicks a day, and D1 writes allow about 12,000. Past the Queue allowance, links still redirect, but the extra clicks are not recorded until 00:00 UTC.
