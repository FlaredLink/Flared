# Reset a forgotten password

A member who forgets their password asks the owner for a reset link: the owner creates it in **Settings → Members** (see [members.md](members.md)). This page is for the owner's password.

Flared sends no email, so the owner's password reset goes through the Cloudflare account that runs the Worker.

## Before you start

- A clone of your copy of the repository, with `bun install` done.
- Wrangler signed in to the Cloudflare account: `bunx wrangler login`.

## Steps

1. In the repository, run:

   ```sh
   bun run owner:reset-password
   ```

2. The command shows the owner's username. Type `y` to continue.
3. Type the new password twice. It does not show on the screen.

## What it does

- It ends every session, API token, connected app, and passkey of the owner.
- It sets the new password with the same hash format the app uses.
- It records the reset, without the password.

It never reopens setup, creates a user or workspace, or changes links or analytics. The password and its hash never appear in command arguments, logs, or shell history.

If the command stops with an error, run it again. Every step is safe to repeat.

## Change the auth secret

The auth secret signs sessions, and every webhook endpoint secret comes from it. It is `AUTH_SECRET`, or, when `AUTH_SECRET` is not set, the secret that the Worker made and stored at its first request.

When you set `AUTH_SECRET` on an installation that ran on the stored secret, or change `AUTH_SECRET`, every webhook endpoint secret changes:

1. Every delivery fails with `secret_changed`, and Flared does not send it again.
2. **Settings → Webhooks** asks the owner to rotate the secret of each endpoint.
3. The owner rotates each secret, then puts the new secret in the receiver. Events after the rotation are delivered and signed with the new secret only.

Events in between are not delivered. See [webhooks.md](webhooks.md).
