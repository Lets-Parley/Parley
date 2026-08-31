-- Who belongs to a session, and who a round is waiting for.

-- Belonging to a session is durable and is not a reading of who is plugged in.
-- session_presence cannot answer it: Gone deletes a row the moment a socket
-- closes and Sweep deletes whatever a dead replica left behind, so it only
-- ever says "connected recently". An asynchronous round has to wait for people
-- who are away, which is a different question, and this table is the answer to
-- it: one row the first time somebody turns up in the room, kept afterwards.
--
-- It is deliberately narrower than space membership. A forty-member space runs
-- five-person rounds; waiting on the whole roster would mean a round that
-- never completes. It is also wider than members: a link guest has no members
-- row and still turns up, votes, and is waited for like anybody else.
create table session_participants (
    session_id uuid not null references sessions (id) on delete cascade,
    user_id uuid not null references users (id) on delete cascade,
    joined_at timestamptz not null default now(),
    primary key (session_id, user_id)
);

-- Who a round is waiting for, recorded when the round opens: the people who
-- had joined the session by then, minus the spectators.
--
-- Snapshotting is what makes an asynchronous round finishable. Reading the set
-- live would move the goalposts under a round already in progress — somebody
-- turning up halfway through would push completion further away every time —
-- so the expected voters are fixed the moment the story goes on the table and
-- the round waits for exactly those people however long that takes. Somebody
-- who arrives later is welcome to vote; their vote is a bonus and never holds
-- the round shut.
--
-- Rows are only written for a session with openVoting on; a closed round still
-- counts the connected set and never touches this table.
create table round_voters (
    story_id uuid not null references stories (id) on delete cascade,
    user_id uuid not null references users (id) on delete cascade,
    primary key (story_id, user_id)
);
