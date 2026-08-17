-- A space is either protected by a short room code or open to anyone with the
-- link. Empty string is the open case, so every space that already exists stays
-- exactly as reachable as it was before this migration.
--
-- The code is stored readable on purpose: like a Meet or Zoom room code it is
-- meant to be read off the space page by any member and passed on, and hashing
-- it would only mean nobody could ever see it again. It is a door code for a
-- planning-poker room, not a credential tied to a person.
alter table spaces
    add column passcode text not null default '' check (char_length(passcode) <= 12);
