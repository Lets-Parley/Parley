create table stories (
    id uuid primary key default gen_random_uuid(),
    session_id uuid not null references sessions (id) on delete cascade,
    title text not null check (char_length(title) between 1 and 200),
    notes text not null default '' check (char_length(notes) <= 2000),
    position float8 not null,
    estimate text,
    status text not null default 'pending' check (status in ('pending', 'voting', 'estimated')),
    created_at timestamptz not null default now()
);

create index stories_session_idx on stories (session_id, position);

create table votes (
    story_id uuid not null references stories (id) on delete cascade,
    user_id uuid not null references users (id) on delete cascade,
    value text not null,
    primary key (story_id, user_id)
);

alter table sessions add column current_story_id uuid references stories (id);
