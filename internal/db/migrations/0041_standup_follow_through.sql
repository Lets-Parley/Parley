-- Commitment follow-through and "needs you" mentions for standups.

-- Why a commitment was closed. Until now the only way to close one was to
-- answer that it landed, so every closed row is backfilled 'landed'. An open
-- row has no reason. Dropping a commitment closes it exactly as landing does
-- (closed_at, closed_session_id) and leaves the carry count alone, so the
-- stuck rule reads nothing new; this column is the only difference.
--
-- Nullable rather than tied to closed_at by a check: a replica still on the
-- previous binary closes a landed commitment without writing a reason, and
-- that row must not be refused. Readers treat a closed row with no reason as
-- landed, which is what it was.
alter table standup_commitments
    add column closed_reason text null check (closed_reason in ('landed', 'dropped'));

update standup_commitments set closed_reason = 'landed' where closed_at is not null;

-- One member asking another for help with a blocker, in one standup. The
-- target is a user id picked from the space's members, never free text. Only
-- the person mentioned is ever shown who asked, and only the person asking is
-- shown whom they asked: nothing here reaches the room's shared state.
--
-- Membership is checked when the row is written, not enforced by a foreign
-- key: a link guest holds a users row and no members row, so a key on users
-- would accept one. Leaving the space later does not delete the row; the
-- session tree is what stops a former member reading it.
create table standup_mentions (
    session_id uuid not null references sessions (id) on delete cascade,
    from_user_id uuid not null references users (id) on delete cascade,
    to_user_id uuid not null references users (id) on delete cascade,
    created_at timestamptz not null default now(),
    primary key (session_id, from_user_id, to_user_id),
    check (from_user_id <> to_user_id)
);

-- The "needs you" read: one person's mentions in one session.
create index standup_mentions_to_idx on standup_mentions (session_id, to_user_id);
