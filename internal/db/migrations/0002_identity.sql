create table users (
    id uuid primary key default gen_random_uuid(),
    name text not null check (char_length(name) between 1 and 64),
    created_at timestamptz not null default now()
);

create table session_tokens (
    token_hash bytea primary key,
    user_id uuid not null references users (id) on delete cascade,
    created_at timestamptz not null default now(),
    last_used_at timestamptz not null default now()
);

create index session_tokens_user_id_idx on session_tokens (user_id);
