create table sessions (
    id uuid primary key default gen_random_uuid(),
    space_id uuid not null references spaces (id) on delete cascade,
    kind text not null check (kind in ('poker', 'standup')),
    title text not null check (char_length(title) between 1 and 200),
    config jsonb not null default '{}',
    phase text not null default '',
    revealed bool not null default false,
    version bigint not null default 1,
    facilitator_id uuid not null references users (id),
    facilitator_seen_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    ended_at timestamptz
);

create index sessions_space_id_idx on sessions (space_id, created_at desc);
