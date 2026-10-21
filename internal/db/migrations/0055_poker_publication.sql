create table poker_publication_reviews (
    id uuid primary key default gen_random_uuid(),
    session_id uuid not null references sessions(id) on delete cascade,
    parent_id uuid not null,
    principal_id uuid not null references users(id),
    fingerprint text not null,
    revision bigint generated always as identity unique,
    request jsonb not null,
    steps jsonb not null,
    created_at timestamptz not null default now(),
    foreign key(parent_id,session_id) references stories(id,session_id)
);
create index poker_publication_reviews_session_idx on poker_publication_reviews(session_id);

create table poker_publication_steps (
    operation_key text primary key,
    session_id uuid not null references sessions(id) on delete cascade,
    parent_id uuid not null,
    target_key text not null,
    issue_type text not null,
    kind text not null check(kind in ('create','parent','dependency','remove-dependency','estimate')),
    state text not null check(state in ('local-only','waiting-for-issues','pending','confirmed','failed','unknown')),
    remote_id text,
    attempts integer not null default 0 check(attempts>=0),
    lease_id uuid,
    lease_until timestamptz,
    updated_at timestamptz not null default now(),
    foreign key(parent_id,session_id) references stories(id,session_id),
    check ((lease_id is null)=(lease_until is null))
);
create index poker_publication_steps_session_idx on poker_publication_steps(session_id);
create index poker_publication_steps_target_idx on poker_publication_steps(target_key);
