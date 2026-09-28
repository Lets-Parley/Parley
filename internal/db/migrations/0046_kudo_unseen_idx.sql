-- Two queries find a recipient's unseen kudos: the kudoWaiting subquery in
-- Spaces.ForUser (internal/store/spaces.go) and Kudos.WaitingFor
-- (internal/store/kudos.go). Neither matches kudos_space_created_idx
-- (space_id, created_at desc) from 0033_kudos.sql, so both read every kudo the
-- space holds and filter to_user_id/seen_at on the heap. The 500-per-space cap
-- that used to bound this became a rolling 30-day cap in #700, so a
-- space's kudos now grow for its whole life.
--
-- This index is partial: a kudo leaves it the moment it is seen, so it stays
-- small regardless of how long a space has been running.
--
-- Built plainly, not concurrently: internal/db/migrate.go runs every
-- migration inside its own transaction, and Postgres refuses CREATE INDEX
-- CONCURRENTLY inside a transaction. A plain build is acceptable here because
-- the index only covers unseen rows, which stay a small fraction of a space's
-- kudos.
create index kudos_unseen_by_recipient_idx on kudos (to_user_id, space_id)
    where seen_at is null;
