create table standup_entries (
    session_id uuid not null references sessions (id) on delete cascade,
    user_id uuid not null references users (id) on delete cascade,
    yesterday text not null default '' check (char_length(yesterday) <= 2000),
    today text not null default '' check (char_length(today) <= 2000),
    blockers text not null default '' check (char_length(blockers) <= 2000),
    position float8 not null,
    skipped bool not null default false,
    updated_at timestamptz not null default now(),
    primary key (session_id, user_id)
);

alter table sessions add column current_speaker_id uuid references users (id);
alter table sessions add column speaker_started_at timestamptz;
