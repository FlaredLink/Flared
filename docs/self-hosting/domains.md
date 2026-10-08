# Use your own domains for links

Short links can use a subdomain you own, such as `go.example.com`. The domain must be on Cloudflare in the same account as the Worker. Root domains such as `example.com` are not supported.

## Steps

1. In Flared, open **Domains** and add the hostname.
2. In the Cloudflare dashboard, open **Workers & Pages → flared → Settings → Domains & Routes → Add → Custom domain** and enter the same hostname. Cloudflare creates the DNS record and the certificate. Cloudflare refuses a hostname that already has a CNAME record; delete that record first.
3. Wait for the check, or choose **Check now** in Domains. The domain then shows **Active**.

Flared checks waiting domains every 10 minutes. A check fetches `https://go.example.com/.well-known/flared-domain-challenge` and expects a random value that this Worker serves only for that hostname, only while the domain waits. A match proves the hostname reaches your Worker over HTTPS. Flared needs no Cloudflare API token for this.

## If it stays waiting

- The Custom Domain is missing, or it belongs to another Worker.
- The certificate is not issued yet. This usually takes a few minutes.
- The hostname redirects. The check follows no redirects.

A domain that is not active within 7 days shows **Failed**. Remove it and add it again.

## Remove a domain

Removing a domain in Flared stops its links at once. Then remove the Custom Domain in the Cloudflare dashboard.

An upgrade keeps your Custom Domains: a deploy from the Wrangler configuration, which lists no routes, leaves the Custom Domains added in the dashboard in place.

To move the app itself to your own address, see [origin.md](origin.md).
