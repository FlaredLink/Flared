-- SPDX-License-Identifier: AGPL-3.0-only
-- Pages: a profile with buttons, headers, social links, and add-ons, shown at <handle> on the
-- edition's page host or at the root of a workspace domain.
-- NULL: not projected by a version that knows pages yet; counts as 0.
ALTER TABLE tenant_policy ADD COLUMN page_limit INTEGER CHECK (page_limit IS NULL OR page_limit >= 0);
ALTER TABLE tenant_policy ADD COLUMN page_extras INTEGER CHECK (page_extras IS NULL OR page_extras IN (0,1));

-- Lets a page block name a link of its own workspace only (see page_blocks).
CREATE UNIQUE INDEX links_tenant_id ON links(tenant_id, id);

-- Permanent, as slug reservations: a handle once used stays with its workspace, also after the
-- page or the workspace is deleted, so nobody else can take an address that was shared. page_id
-- is the page that has or last had the handle; released_at is set when that page moves to another
-- handle or is deleted. The rules match handlePattern in the contracts.
CREATE TABLE page_handles (
 handle TEXT PRIMARY KEY NOT NULL CHECK (length(handle) BETWEEN 3 AND 30 AND handle NOT GLOB '*[^a-z0-9-]*' AND handle NOT GLOB '-*' AND handle NOT GLOB '*-' AND handle NOT GLOB '*--*'),
 tenant_id TEXT NOT NULL,
 page_id TEXT NOT NULL,
 released_at INTEGER,
 created_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX page_handles_page ON page_handles(page_id);
CREATE TRIGGER page_handles_kept BEFORE DELETE ON page_handles
BEGIN
 SELECT RAISE(ABORT, 'page handles are permanent');
END;
CREATE TRIGGER page_handles_owner_fixed BEFORE UPDATE OF handle, tenant_id ON page_handles
BEGIN
 SELECT RAISE(ABORT, 'a page handle stays with its workspace');
END;

-- Handles that the operator keeps, such as brand and service words; no workspace can take them.
CREATE TABLE reserved_handles (
 handle TEXT PRIMARY KEY NOT NULL,
 created_at INTEGER NOT NULL
) WITHOUT ROWID;

-- domain_id: the workspace domain whose root shows the page. avatar_image and background_image
-- name uploaded files, such as 3q2-7wEAAAAAAAAAAAAAAA.png. theme is the theme ID and the
-- member's changes to it, as JSON.
CREATE TABLE pages (
 id TEXT PRIMARY KEY NOT NULL,
 tenant_id TEXT NOT NULL,
 handle TEXT NOT NULL UNIQUE REFERENCES page_handles(handle),
 domain_id TEXT UNIQUE REFERENCES domain_namespaces(id),
 title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 100),
 bio TEXT CHECK (bio IS NULL OR length(bio) BETWEEN 1 AND 300),
 avatar_image TEXT CHECK (avatar_image IS NULL OR (length(avatar_image) BETWEEN 26 AND 27 AND (avatar_image GLOB '*.png' OR avatar_image GLOB '*.jpg' OR avatar_image GLOB '*.webp'))),
 background_image TEXT CHECK (background_image IS NULL OR (length(background_image) BETWEEN 26 AND 27 AND (background_image GLOB '*.png' OR background_image GLOB '*.jpg' OR background_image GLOB '*.webp'))),
 theme TEXT NOT NULL CHECK (json_valid(theme) AND length(theme) <= 2048),
 status TEXT NOT NULL CHECK (status IN ('active','disabled')),
 blocked_at INTEGER,
 blocked_reason TEXT CHECK (blocked_reason IS NULL OR blocked_reason IN ('phishing','malware','spam','illegal','other')),
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 UNIQUE (id, tenant_id),
 CHECK ((blocked_at IS NULL) = (blocked_reason IS NULL))
);
CREATE INDEX pages_tenant_created ON pages(tenant_id, created_at, id);

-- A page's blocks in order. A button or payment block opens a link of the same workspace, so
-- its clicks count as link clicks; the foreign key refuses a link of another workspace. data
-- holds the fields of the kind as JSON (parsePageBlock in the contracts checks them).
CREATE TABLE page_blocks (
 page_id TEXT NOT NULL,
 tenant_id TEXT NOT NULL,
 position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 99),
 kind TEXT NOT NULL CHECK (kind IN ('button','header','social','payment','embed','signup')),
 link_id TEXT,
 label TEXT CHECK (label IS NULL OR length(label) BETWEEN 1 AND 100),
 data TEXT CHECK (data IS NULL OR (json_valid(data) AND length(data) <= 4096)),
 starts_at INTEGER,
 ends_at INTEGER CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at),
 PRIMARY KEY (page_id, position),
 FOREIGN KEY (page_id, tenant_id) REFERENCES pages(id, tenant_id) ON DELETE CASCADE,
 FOREIGN KEY (tenant_id, link_id) REFERENCES links(tenant_id, id),
 CHECK ((kind IN ('button','payment')) = (link_id IS NOT NULL))
) WITHOUT ROWID;
CREATE INDEX page_blocks_link ON page_blocks(tenant_id, link_id) WHERE link_id IS NOT NULL;
