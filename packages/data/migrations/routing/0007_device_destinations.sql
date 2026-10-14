-- SPDX-License-Identifier: AGPL-3.0-only
-- Device destinations: where iPhone and Android visitors go instead of the destination, such as
-- an app link. NULL sends them to the destination. Redirects choose one by the visitor's OS.
ALTER TABLE links ADD COLUMN ios_destination TEXT;
ALTER TABLE links ADD COLUMN android_destination TEXT;
