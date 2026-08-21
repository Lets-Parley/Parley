-- A chosen avatar: an icon and an optional accessory, both opaque client-side
-- ids. The server never enumerates them — it stores what the client picked and
-- hands it back, so adding an icon to the picker needs no migration here.
--
-- Existing rows default to the empty pair, which every surface already renders
-- as the derived-hue initial. No backfill, and the default is constant, so on
-- PostgreSQL 11+ this rewrites no heap.
--
-- The length check is a storage bound, not the format rule: the API validates
-- the id shape at the trust boundary.
alter table users
    add column avatar_icon text not null default '' check (char_length(avatar_icon) <= 32),
    add column avatar_accessory text not null default '' check (char_length(avatar_accessory) <= 32);
