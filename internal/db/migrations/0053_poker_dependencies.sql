alter table stories add column dependency_revision bigint not null default 0 check (dependency_revision >= 0);

create table poker_dependencies (
    id uuid primary key default gen_random_uuid(),
    session_id uuid not null references sessions(id) on delete cascade,
    parent_id uuid not null,
    blocker_id uuid not null,
    dependent_id uuid not null,
    review_needed boolean not null default false,
    retired_at timestamptz,
    unique (parent_id, blocker_id, dependent_id),
    check (blocker_id <> dependent_id),
    foreign key (parent_id, session_id) references stories(id, session_id),
    foreign key (blocker_id, session_id) references stories(id, session_id),
    foreign key (dependent_id, session_id) references stories(id, session_id)
);
create index poker_dependencies_session_idx on poker_dependencies(session_id);
