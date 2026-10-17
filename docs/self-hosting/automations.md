# Automations

An automation is a template with one trigger and one or more actions. You apply it to links. On each link, it runs once when its trigger is met.

## Triggers

| Trigger | When it runs |
| --- | --- |
| End date | At the date and time you choose when you apply it. A date in the past runs at the next automation run. |
| Days after creation | A number of days after the link was created, from 1 to 3,650. |
| Clicks | When the link reaches a number of recorded clicks: a multiple of 100, from 100 to 100,000,000. |

A click past the monthly limit is not recorded, so it does not count toward a clicks trigger.

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

The 10-minute cron runs due automations at :10, :30, and :50 each hour, so an automation runs within 20 minutes after its trigger is met. The other runs check waiting domains. The two take turns to stay inside the 50 subrequests and 50 D1 queries that Workers Free allows for one run. One run handles up to 25 automations; the rest wait for the next one.

## Limits

A workspace can keep 25 templates by default. The owner changes the number in **Settings → Limits and usage**, from 0 to 100; see [limits.md](limits.md). At 0, no template can be added or applied, and applications that come due are skipped. Existing templates stay listed.
