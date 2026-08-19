-- Session kinds live in a table so a new ceremony is a row, not a schema
-- change. Order matters: the table and its seed rows have to exist before the
-- foreign key is added, or validating it against existing sessions fails.
create table session_kinds (
    kind text primary key check (char_length(kind) between 1 and 64),
    provider text not null check (char_length(provider) between 1 and 64),
    display text not null check (char_length(display) between 1 and 64),
    retired_at timestamptz
);

insert into session_kinds (kind, provider, display) values
    ('poker', 'core', 'Planning Poker'),
    ('standup', 'core', 'Standup');

-- RESTRICT, not the NO ACTION Postgres would default to and never CASCADE: a
-- kind that has sessions is retired by setting retired_at, never deleted, so
-- historical sessions keep a kind that resolves.
alter table sessions
    add constraint sessions_kind_fkey foreign key (kind)
    references session_kinds (kind) on delete restrict;

alter table sessions drop constraint sessions_kind_check;
