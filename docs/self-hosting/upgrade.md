# Upgrade

Flared has no automatic upgrades. You choose when to upgrade.

1. Read the release notes of the tag, such as `v0.2.0`, on [GitHub](https://github.com/FlaredLink/Flared/releases).
2. In your copy, fetch and merge the tag:

   ```sh
   git remote add upstream https://github.com/FlaredLink/Flared.git   # once
   git fetch upstream --tags
   git merge v0.2.0
   ```

3. Read the new files in `packages/data/migrations/`. A migration cannot be undone by deploying older code.
4. Push. Workers Builds runs `bun run build`, then `bun run deploy`, which applies the migrations before it deploys the Worker.

Secrets such as `APP_ORIGIN` stay as they are. If you changed the code, publish your version and set `SOURCE_URL` to it, so the "Source code" link offers your users the code they use (AGPL section 13).

Before an upgrade with migrations, note the time for a [Time Travel restore](backups.md).
