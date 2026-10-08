# Backups

D1 keeps a point-in-time history of each database (Time Travel): 7 days on Workers Free and 30 days on Workers Paid.

## Restore a database

1. Find the time before the problem, in UTC.
2. Restore each affected database to that time. For example:

   ```sh
   bunx wrangler d1 time-travel restore flared-identity --timestamp=2026-10-07T12:00:00Z
   ```

   The other databases are `flared-routing` and `flared-analytics-1`.

A restore replaces the database with its state at that time.

- Restore the identity and routing databases to the same time, so accounts, workspaces, and links match.
- A routing restore also removes the slug reservations made after that time. A link address deleted later could then be used again for another destination. Restore the routing database only when you accept that.
- Redirects keep each link for up to 60 seconds, so a restored link can take a minute to change.

## Export

**Settings → Export** downloads your links and daily click totals as files.
