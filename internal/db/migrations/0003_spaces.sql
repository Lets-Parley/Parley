create table spaces (
    id uuid primary key default gen_random_uuid(),
    slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$' or slug ~ '^[a-z0-9]$'),
    name text not null check (char_length(name) between 1 and 64),
    created_at timestamptz not null default now()
);

create table members (
    space_id uuid not null references spaces (id) on delete cascade,
    user_id uuid not null references users (id) on delete cascade,
    spectator bool not null default false,
    last_seen_at timestamptz not null default now(),
    primary key (space_id, user_id)
);
