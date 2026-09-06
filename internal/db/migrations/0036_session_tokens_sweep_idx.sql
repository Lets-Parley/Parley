-- Indexes for Users.SweepExpiredTokens. The sweep selects victims with
--
--     last_used_at <= now() - idle
--  or created_at   <= now() - max
--  or (expires_at is not null and expires_at <= now())
--
-- and deletes them by ctid in batches of 1000. session_tokens previously
-- carried only the token_hash primary key and a user_id index, so every
-- batch sequentially scanned the heap. Steady state is one pass per hour
-- per replica; the first run after an upgrade is ceil(N/1000) of them.
--
-- last_used_at is rewritten on every session touch (any write or WebSocket
-- connect). Indexing it prevents HOT updates of that column. That is
-- accepted: the alternative is a full heap scan of every live token on
-- every replica every hour, and created_at / expires_at are immutable
-- after insert so their indexes do not pay that cost. A narrower set
-- (created_at plus the partial expires_at index) would miss idle-expired
-- rows that are still inside SESSION_MAX_TTL, which is the common case
-- once the absolute cap is longer than the idle window.
--
-- The expires_at index is partial because only redeemed guest links set
-- it; ordinary sessions stay null and must not occupy the index.
--
-- create index concurrently cannot run inside a transaction, and
-- migrate.go wraps each migration file in one, so this is a regular
-- create index. Boot serialises behind the migration advisory lock.

create index session_tokens_last_used_at_idx
    on session_tokens (last_used_at);

create index session_tokens_created_at_idx
    on session_tokens (created_at);

create index session_tokens_expires_at_idx
    on session_tokens (expires_at)
    where expires_at is not null;
