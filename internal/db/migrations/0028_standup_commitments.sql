-- What somebody said they would do, carried until they say it is done.

-- A commitment belongs to a space and a person, not to a session. The session
-- columns record when it was opened and when it was closed, but the open set
-- for a (space_id, user_id) IS the carry-over list and is read directly. There
-- is deliberately no cross-session lookback query: nothing walks yesterday's
-- standup to work out what is outstanding.
--
-- carried only moves when somebody answers "not yet". Absence from a session
-- does nothing at all, so a week off does not manufacture a stuck commitment.
create table standup_commitments (
    id uuid primary key default gen_random_uuid(),
    space_id uuid not null references spaces (id) on delete cascade,
    user_id uuid not null references users (id) on delete cascade,
    text text not null check (char_length(text) between 1 and 500),
    opened_session_id uuid not null references sessions (id) on delete cascade,
    -- on delete set null, not cascade: deleting the session somebody happened
    -- to be in when they finished a commitment must not reopen it.
    closed_session_id uuid null references sessions (id) on delete set null,
    carried int not null default 0,
    created_at timestamptz not null default now()
);

-- The open list, which is the only list anything reads.
create index standup_commitments_open_idx
    on standup_commitments (space_id, user_id) where closed_session_id is null;
