-- A personal calendar feed. The token is never stored: only its sha256 digest,
-- the same shape session_tokens uses, plus a short lookup prefix taken from
-- the token so a request finds the row without scanning every hash. One row
-- per user. Deleting the user cascades the row. Revoking stamps revoked_at
-- and leaves the hash in place so the old URL stops resolving.
create table ics_feed_tokens (
    user_id uuid primary key references users (id) on delete cascade,
    lookup_prefix text not null check (char_length(lookup_prefix) = 8),
    token_hash bytea not null,
    remind_minutes integer not null check (remind_minutes between 0 and 1440),
    created_at timestamptz not null default now(),
    revoked_at timestamptz
);

create unique index ics_feed_tokens_lookup_prefix_idx
    on ics_feed_tokens (lookup_prefix)
    where revoked_at is null;
