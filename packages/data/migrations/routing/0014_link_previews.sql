-- SPDX-License-Identifier: AGPL-3.0-only
-- Social previews. NULL: not projected by a version that knows previews yet; counts as 0.
ALTER TABLE tenant_policy ADD COLUMN link_previews INTEGER CHECK (link_previews IS NULL OR link_previews IN (0,1));
-- What card bots (Slack, X, LinkedIn, and others) show for the link instead of the destination's
-- own tags. preview_image names the uploaded file, such as 3q2-7wEAAAAAAAAAAAAAAA.png; the object
-- lives in the preview image store under <tenant>/<link>/<file>.
ALTER TABLE links ADD COLUMN preview_title TEXT CHECK (preview_title IS NULL OR length(preview_title) BETWEEN 1 AND 200);
ALTER TABLE links ADD COLUMN preview_description TEXT CHECK (preview_description IS NULL OR length(preview_description) BETWEEN 1 AND 500);
ALTER TABLE links ADD COLUMN preview_image TEXT CHECK (preview_image IS NULL OR (length(preview_image) BETWEEN 26 AND 27 AND (preview_image GLOB '*.png' OR preview_image GLOB '*.jpg' OR preview_image GLOB '*.webp')));
