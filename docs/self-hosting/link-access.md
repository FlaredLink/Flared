# Start and end times and passwords

A link can open at a start time, stop at an end time, and send visitors to another address after the end. It can also ask visitors for a password before the redirect. Set these under **More options** when you create a link, or when you edit one, with the CLI (`--starts-at`, `--ends-at`, `--ended-destination`, `--password`), with the API, or through an AI assistant.

- Before the start, visitors see that the link is not open yet. After the end, they go to the address for after the end, or see that the link has ended. These visits count no clicks.
- A visitor who enters the right password goes to the destination, and the click counts. Link previews and other automated clients see the password page.
- Each link and visitor IP gets 10 tries a minute.

## What the installation needs

The Worker needs the rate limiting binding `LINK_PASSWORD_ATTEMPTS` from `wrangler.jsonc`. Without it, no password can be set, and a link that has one shows "This link can't open right now".

Flared stores a keyed hash of each password. The key comes from the auth secret (`AUTH_SECRET`, or the one the Worker made at its first request). If the auth secret changes, every link password stops working: the links show "This link can't open right now" until you set their passwords again.
