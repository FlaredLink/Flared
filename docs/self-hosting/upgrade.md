# Upgrade

You choose when to upgrade. Upgrade with the GitHub workflow below, which opens a pull request for each release, or merge a release by hand. Nothing upgrades on its own unless you turn on auto mode in the workflow.

## Update notices

The app can tell the owner when a new release is out. The setup wizard asks once, and **Settings → Updates** changes it later; it is off until the owner turns it on. While it is on, the daily job reads `https://flared.page/releases/latest.json`: one HTTPS request with no cookie, no version, and no data about your installation. Like any website, flared.page sees the request's network address, which is a Cloudflare address. The app then shows the owner a notice with the new version, its summary, whether it changes the databases, and the commands below. Turning it on checks at once. A failed check changes nothing else, and the app tries again the next day. Turning it off stops the requests and clears the result.

## Upgrade with GitHub Actions

The workflow [`deploy/flared-upgrade.yml`](../../deploy/flared-upgrade.yml) runs in your copy each day. It merges the newest release into the branch `flared-upgrade/vX.Y.Z` and opens a pull request with the release notes and the list of database changes. Deploy on Cloudflare leaves workflows out of your copy, so add it once:

1. Add the file to your repository as `.github/workflows/flared-upgrade.yml`. In the app, Settings → Updates asks for your repository's name and opens GitHub's new-file page with the file filled in; select **Commit changes**. It also shows the file with a copy button.
2. In the repository settings, open **Actions → General** and allow GitHub Actions to create and approve pull requests.
3. Optional: add the repository variable `FLARED_AUTO_UPGRADE` with the value `true` (**Settings → Secrets and variables → Actions → Variables**). The workflow then merges each pull request whose merge is clean, unless a release in it is marked breaking. The push to your main branch makes Workers Builds deploy.

Merge its pull requests with **Create a merge commit**. A squash or rebase merge drops the Flared history that the next upgrade needs. Before you merge a pull request with database changes, note the time for a [Time Travel restore](backups.md); the workflow does not touch Cloudflare, so it cannot.

The workflow uses only your repository's own token. It keeps your `.github/workflows` as they are and never adds Flared's own. To upgrade to a release that is not the newest, run it from the **Actions** tab with the release tag, such as `v0.2.0`. The same input takes a pre-release tag, such as `v0.2.0-rc.1`, to test a release on a copy first; the daily run never takes a pre-release.

It opens one issue, and no pull request, when you must act: when a release does not merge cleanly into your changes, or when your copy has no Flared history and the workflow cannot prove which release it came from. A copy made before 13 October 2026 needs the first upgrade by hand (below). The issue names the steps; the workflow closes it when a pull request opens.

GitHub turns off scheduled workflows in a repository with no activity for 60 days. Turn it on again in the **Actions** tab.

## Upgrade by hand

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
4. If the merge added files under `.github/workflows/`, remove them: they are Flared's own checks, which Deploy left out of your copy.
5. Push. Workers Builds runs `bun run build`, then `bun run deploy`, which applies the migrations before it deploys the Worker.

Secrets such as `APP_ORIGIN` stay as they are. Since v0.1.1, `APP_ORIGIN` and `AUTH_SECRET` are optional, but keep them if your copy has them: without `AUTH_SECRET`, the Worker makes a new key and everyone must sign in again. If you changed the code, publish your version and set `SOURCE_URL` to it, so the "Source code" link offers your users the code they use (AGPL section 13).

Before an upgrade with migrations, note the time for a [Time Travel restore](backups.md).
