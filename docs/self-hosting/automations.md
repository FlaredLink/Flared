# Automations

An automation is a template with one trigger and one or more actions. You apply it to links. On each link, it runs once when its trigger is met.

## Triggers

| Trigger | When it runs |
| --- | --- |
| End date | At the date and time you choose when you apply it. A date in the past runs at the next automation run. |
| Days after creation | A number of days after the link was created, from 1 to 3,650. |
| Clicks | When the link reaches a number of recorded clicks: a multiple of 100, from 100 to 100,000,000. |
| Destination stops loading | When two checks in a row find that the link's destination does not load. See [Destination checks](#destination-checks). |

A click past the monthly limit is not recorded, so it does not count toward a clicks trigger.

## Destination checks

For each link with a "Destination stops loading" automation, the installation requests the destination about every six hours. Each request uses the user agent `Flared-LinkCheck/1.0 (+https://github.com/FlaredLink/Flared/blob/main/docs/self-hosting/automations.md)`.

- A check is a `GET` request. It follows up to 2 redirects, so it makes at most 3 requests. Each request has 10 seconds to answer, and the check reads at most 1 KB of the page.
- A check fails when the request gets no answer, takes more than 10 seconds, or the page answers 404, 410, or a 5xx status. A 503 with a Cloudflare challenge (`cf-mitigated: challenge`) does not fail.
- Other answers show that the site is up: 2xx, 401, 403, 429, the other 4xx statuses, and a redirect at the third request.
- Two failed checks in a row of the same destination run the automation. A check that passes starts the count again. If you change the destination, the count also starts again.
- Links with the same destination share one request in each run.

A check requests only an http or https URL on the default port, on a public hostname: no IP address, no single-label name, and no reserved suffix such as `.local`. It never requests the installation's own hostname or a domain added to the installation. You cannot apply the automation to a link whose destination breaks these rules. If a destination or a redirect breaks them later, the link shows "Flared cannot check this destination", the automation keeps waiting, and the check does not count as failed.

The checks run at :30 each hour, 6 links in each run, so about 36 links get a check every six hours. With more links, each link is checked less often. Links checked longest ago go first. A template that is off, or an automation limit of 0, stops the checks. The link's page shows the time and the result of the last check, and the number of failed checks in a row.

## Actions

The actions run in this order:

1. **Change destination** sends the short link to a new URL.
2. **Turn off** stops the short link.
3. **Send webhook** sends an `automation.triggered` event to one endpoint; see [webhooks.md](webhooks.md).

This edition sends no email, so it has no email action.

If Flared blocked the link for abuse, a template that changes the destination does nothing on it, and the run shows as failed. If the endpoint was deleted, or the webhook endpoint limit is 0, the link actions still run and the run shows as failed.

## Manage automations

The owner creates, changes, turns off, and deletes templates in **Automations**. Members see the templates.

Members and the owner apply a template to links on the **Links** page: select links, then choose **Apply automation**. A link's page lists its automations, and each one can be applied or removed there. API tokens and AI assistants can list, apply, and remove automations; templates are made in the app only.

- A link takes up to 5 automations.
- Applying a template again to a link where it already ran makes it wait to run again.
- A template that is off does not run. Applications that come due while it is off are skipped.
- Each run is listed under its template for 90 days.

## Timing

The 10-minute cron runs due automations at :10, :30, and :50 each hour, so an automation runs within 20 minutes after its trigger is met. The run at :30 checks destinations first, so a destination that fails its second check runs its automation in the same run. The other runs check waiting domains. The two take turns to stay inside the 50 subrequests and 50 D1 queries that Workers Free allows for one run. One run handles up to 25 automations; the rest wait for the next one.

## Limits

A workspace can keep 25 templates by default. The owner changes the number in **Settings → Limits and usage**, from 0 to 100; see [limits.md](limits.md). At 0, no template can be added or applied, and applications that come due are skipped. Existing templates stay listed.
