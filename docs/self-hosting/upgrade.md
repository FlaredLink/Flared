# Upgrade

Flared has no automatic upgrades. You choose when to upgrade.

## Update notices

The app can tell the owner when a new release is out. The setup wizard asks once, and **Settings → Updates** changes it later; it is off until the owner turns it on. While it is on, the daily job reads `https://flared.page/releases/latest.json`: one HTTPS request with no cookie, no version, and no data about your installation. Like any website, flared.page sees the request's network address, which is a Cloudflare address. The app then shows the owner a notice with the new version, its summary, whether it changes the databases, and the commands below. Turning it on checks at once. A failed check changes nothing else, and the app tries again the next day. Turning it off stops the requests and clears the result.

## Upgrade a copy

1. Read the release notes of the tag, such as `v0.2.0`, on [GitHub](https://github.com/FlaredLink/Flared/releases).
2. In your copy, fetch and merge the tag:

   ```sh
   git remote add upstream https://github.com/FlaredLink/Flared.git   # once
   git fetch upstream --tags
   git merge v0.2.0
   ```

   Deploy on Cloudflare creates your copy as one new commit with no Flared history, so the first merge stops with "refusing to merge unrelated histories". Once, before that first merge, record the Flared version your copy came from, such as `v0.1.0`: the `version` in your copy's `package.json`, also shown in the app's footer. This keeps your files, including the database IDs that Cloudflare wrote into `wrangler.jsonc`:

   ```sh
   git merge --allow-unrelated-histories -s ours -m "Record the Flared version this copy came from" v0.1.0
   ```

   Then merge the new tag. Only files that Flared changed since your version change; your database IDs stay.

   If your copy was created before 13 October 2026, it came from a commit before `v0.1.0`, so the step above would skip changes it needs. Use these commands instead, once. They replace every file with the `v0.1.0` version and keep your `wrangler.jsonc`. If you changed code, apply your changes again after them.

   ```sh
   git merge --allow-unrelated-histories -s ours --no-commit v0.1.0
   git read-tree -u --reset v0.1.0
   git checkout HEAD -- wrangler.jsonc
   git commit -m "Upgrade to Flared v0.1.0"
   ```

3. Read the new files in `packages/data/migrations/`. A migration cannot be undone by deploying older code.
4. Push. Workers Builds runs `bun run build`, then `bun run deploy`, which applies the migrations before it deploys the Worker.

Secrets such as `APP_ORIGIN` stay as they are. If you changed the code, publish your version and set `SOURCE_URL` to it, so the "Source code" link offers your users the code they use (AGPL section 13).

Before an upgrade with migrations, note the time for a [Time Travel restore](backups.md).
