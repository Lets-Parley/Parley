-- A kudo is a note from one member of a space to another. One table serves
-- both surfaces: the space's kudos wall, and the kudos given during a standup
-- shown as that session's closing beat. A kudo given in a room appears on the
-- wall unchanged, because there is only ever one row and one read path.
--
-- THERE IS NO LEADERBOARD. This is a schema constraint, not a UI choice: no
-- count column, no aggregate, no per-person total. Storing a count is enough to
-- invite a ranking, and a ranking turns thanks into a scoreboard people play.
-- Adding a count column here means arguing with this paragraph first.
--
-- session_id is nullable and `on delete set null`, not cascade, for the reason
-- 0018_session_links.sql already argues about votes, and in the shape
-- 0028_standup_commitments.sql already uses for closed_session_id: deleting the room
-- must not erase the thank-you given in it. It lives here rather than in the
-- standup phase because the standup surface needs the kudos of one session,
-- and discovering that later would mean amending a shipped migration.
--
-- Membership is deliberately not expressible here. A link guest holds a users
-- row but no members row, so the sender and recipient foreign keys would
-- happily accept one; the membership check in internal/store/kudos.go is the
-- only defence, and it is tested as such.
create table kudos (
    id uuid primary key default gen_random_uuid(),
    space_id uuid not null references spaces (id) on delete cascade,
    from_user_id uuid not null references users (id) on delete cascade,
    to_user_id uuid not null references users (id) on delete cascade,
    text text not null check (char_length(text) between 1 and 280),
    session_id uuid null references sessions (id) on delete set null,
    created_at timestamptz not null default now(),
    check (from_user_id <> to_user_id)
);

-- The only read is "this space's kudos, newest first".
create index kudos_space_created_idx on kudos (space_id, created_at desc);
