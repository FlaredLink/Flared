# Reset a forgotten password

Flared sends no email, so a password reset goes through the Cloudflare account that runs the Worker.

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
