# Link cards

A link card is what Slack, LinkedIn, X, WhatsApp, and other apps show when someone shares a link. By default, these apps follow the short link and show the destination page's own title, description, and image. You can give a link its own card instead: set **Card title**, **Card description**, and **Card image** under **More options** when you create or edit a link, with the CLI (`--preview-title`, `--preview-description`, `--preview-image`), with the API, or through an AI assistant (title and description only).

- The apps that build cards get a small page with the card tags. People always go to the destination, and the card apps count no clicks.
- A link with a password shows its card too. The card never names the destination.
- Before a link's start time, after its end, and while it is off, it shows no card and no image.
- The image is PNG, JPEG, or WebP, up to 5 MB. 1200 × 630 pixels shows best. It is served on the short link's own address, such as `https://go.example.com/launch/preview/...`.

## Add the image store

Card titles and descriptions work without setup. The images need an R2 bucket, and R2 must be turned on in your Cloudflare account (the dashboard asks for a payment method; the free allowance covers most installations).

1. Create a bucket: `npx wrangler r2 bucket create flared-previews`.
2. Add the binding to `wrangler.jsonc` in your copy of the repository, then deploy:

   ```jsonc
   "r2_buckets": [{ "binding": "PREVIEW_IMAGES", "bucket_name": "flared-previews" }]
   ```

Without the binding, the image field answers "Preview images are not available on this installation", and cards show the title and description only. Deleting the workspace deletes its images. A new or removed image deletes the old file.
