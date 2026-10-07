# Move the app to another address

The app address comes from the `APP_ORIGIN` secret. It sets the cookie host, the allowed `Origin`, the passkey relying party, the OAuth issuer, and the MCP endpoint.

## Steps

1. Add the new hostname as a Custom Domain of the Worker: **Workers & Pages → flared → Settings → Domains & Routes → Add → Custom Domain**. The zone must be on Cloudflare in the same account.
2. Change the `APP_ORIGIN` secret to the new address, such as `https://links.example.com`. A secret change deploys a new version.
3. Open `https://links.example.com/app/login` and sign in with your username and password.

Until that sign-in, the new address shows only the sign-in page and a notice about the move. A wrong value loses nothing: set `APP_ORIGIN` back and deploy again.

## What the move ends

The first password sign-in at the new address ends, in one step:

- every other session;
- every connected app (OAuth grant), because the issuer changed;
- every passkey, because passkeys belong to the old address. Add them again in Settings.

API tokens keep working.

## Old links

Links on the old address keep working. The old address stays a short-link domain, and its app paths redirect to the new address. Do not turn off `workers.dev` for the Worker if you shared links on it.
