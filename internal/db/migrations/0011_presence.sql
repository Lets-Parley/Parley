-- Who is in a room, shared between replicas.
--
-- Presence used to live in each process's connection map, which is correct for
-- exactly one replica and wrong for two: a member connected to one pod is
-- invisible to the other, and the facilitator reads as offline to everyone who
-- did not land on their pod.
--
-- One row per (session, user, replica): the same person can legitimately hold
-- sockets on more than one pod, and each pod maintains its own row.
create table session_presence (
    session_id uuid not null references sessions (id) on delete cascade,
    user_id uuid not null references users (id) on delete cascade,
    -- Which pod saw them. A replica that dies without closing its sockets
    -- leaves its rows behind; they age out on seen_at rather than being
    -- trusted forever.
    replica_id text not null,
    seen_at timestamptz not null default now(),
    primary key (session_id, user_id, replica_id)
);

-- The sweep and the freshness filter both scan on age.
create index session_presence_seen_at_idx on session_presence (seen_at);
