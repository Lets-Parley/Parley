-- Custom decks owned by a space. A deck row is a template a space picks from,
-- never a reference a session holds: creating a session copies the cards into
-- its config document, so editing or deleting a deck can never invalidate a
-- vote already cast. That is why nothing here is pointed at by sessions.
--
-- The column is `cards`, not `values` — `values` is a reserved word in
-- Postgres and would have to be quoted at every use site.
--
-- There is deliberately no CHECK constraint on the cards: the card rules
-- (count, length, duplicates, reserved specials, numeric-or-ordinal) live in
-- Go, in internal/poker, and are shared with the session-create path. A second
-- copy in SQL is a copy that drifts.
create table decks (
    id uuid primary key default gen_random_uuid(),
    space_id uuid not null references spaces (id) on delete cascade,
    name text not null,
    cards text[] not null,
    ordinal boolean not null default false,
    created_at timestamptz not null default now(),
    unique (space_id, name)
);

-- Every read is "the decks of one space", and the unique constraint above
-- already indexes (space_id, name), so listing is covered without a second
-- index.
