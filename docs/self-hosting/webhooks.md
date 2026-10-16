# Webhooks

A webhook sends a signed HTTPS POST request to your endpoint when a link changes or reaches a click count.

## Events

| Event | When |
| --- | --- |
| `link.created` | A link was created in the app, the CLI, the API, MCP, or an import. |
| `link.updated` | The destination, the title, or an app link of a link changed. |
| `link.disabled` | A link was turned off. |
| `link.enabled` | A link was turned back on. |
| `link.click_milestone` | A link reached a number of recorded clicks. Each endpoint chooses its interval: a multiple of 100, from 100 to 1,000,000. The default is 1,000. |

**Send test** sends a `webhook.test` event to one endpoint, also to an endpoint that is off. A workspace can send 10 test events an hour.

## Manage endpoints

The owner adds and changes endpoints in **Settings → Webhooks**. Members cannot see them. To add an endpoint or to get a new secret, the owner needs a sign-in from the last 10 minutes. The app shows each secret once.

An endpoint URL must:

- use `https` on the default port, 443;
- have a public hostname, which is not the app's own hostname or a subdomain of it;
- have no user name or password;
- have at most 2,048 characters.

The owner can turn an endpoint off and on, rotate its secret, and see its recent deliveries. Deleting an endpoint also deletes its delivery history.

## Limits

A workspace can keep 10 endpoints by default. The owner changes the number in **Settings → Limits and usage**, from 0 to 50; see [limits.md](limits.md). At 0, no endpoint can be added and nothing is sent. Existing endpoints stay listed, and pending deliveries are skipped. A lower number that is not 0 keeps existing endpoints and blocks new ones.

## Verify the signature

Each request has the headers `webhook-id` (the event ID, the same for every attempt), `webhook-timestamp` (the time of the attempt, in Unix seconds), and `webhook-signature`. The signature is `v1,` and a base64 HMAC-SHA256 of the ID, the timestamp, and the raw body, joined by periods. The key is the part of the secret after `whsec_`, decoded from base64. For 24 hours after a rotation, the header has two signatures separated by a space: one from the old secret and one from the new.

The headers follow the Standard Webhooks specification, so its libraries also verify Flared requests. A full example is in the [webhooks documentation](https://flared.page/docs/webhooks).

## Delivery and delays

- The first attempt starts right after the change, from the same request. At most 5 deliveries go out after one change; the rest wait for the scheduled job.
- A 2xx response within 10 seconds is a success. A redirect, another status, a timeout, or a network error is a failure.
- The 10-minute cron sends click milestones, retries, and what a request left. Each run sends at most 25 deliveries, 5 at once, to stay inside the 50 subrequests and 50 D1 queries that Workers Free allows for each run. Milestones and retries can therefore take 10 minutes or more.
- The wait before each retry starts at 1 minute and doubles after each attempt. Because retries run with the cron, a short wait becomes the next run, 10 minutes later.
- A failure pauses the endpoint. The pause starts at 1 minute and doubles with each failing run, up to 512 minutes. A success ends the pause, and so does turning the endpoint off and on or changing its URL.
- A delivery fails after 10 attempts, or when it has not succeeded after 72 hours.
- Delivery is at least once, so an event can arrive more than once. Use `webhook-id` to skip duplicates. Events can arrive out of order; compare `data.link.updatedAt`.
- Events and deliveries are kept for 30 days.

## The auth secret

Endpoint secrets come from the installation's auth secret: `AUTH_SECRET`, or the secret that the Worker stored at its first request. When you set `AUTH_SECRET` for the first time, or change it, every endpoint secret changes. See [recovery.md](recovery.md#change-the-auth-secret).
