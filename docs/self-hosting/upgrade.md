# Upgrade

Flared has no automatic upgrades. You choose when to upgrade.

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

3. Read the new files in `packages/data/migrations/`. A migration cannot be undone by deploying older code.
4. Push. Workers Builds runs `bun run build`, then `bun run deploy`, which applies the migrations before it deploys the Worker.

Secrets such as `APP_ORIGIN` stay as they are. If you changed the code, publish your version and set `SOURCE_URL` to it, so the "Source code" link offers your users the code they use (AGPL section 13).

Before an upgrade with migrations, note the time for a [Time Travel restore](backups.md).
