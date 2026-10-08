-- SPDX-License-Identifier: AGPL-3.0-only
-- Slugs the operator keeps off the platform domains, which every tenant shares. A tenant's own
-- domain is its own namespace, so the list does not apply there. Unlike slug_reservations, a row
-- can be removed; a slug that a link has used stays taken through its permanent reservation.
CREATE TABLE reserved_slugs (
 slug TEXT PRIMARY KEY NOT NULL,
 created_at INTEGER NOT NULL
) WITHOUT ROWID;
