-- A person's self-set away days, for async standups. Each row is an inclusive
-- range of calendar dates. It belongs to the user rather than to a space: a
-- week off is a week off in every team someone stands up with.
--
-- An away person is left out of the open digest's "not yet" list and out of
-- the eligible count behind the team trend. Nothing here, and nothing read
-- from here, computes participation per person: the trend is a team ratio
-- only, and an ended standup serves no away list at all.
--
-- The length check mirrors the handler's limit, so a replica with a looser
-- rule still cannot store a range that swallows a year of standups.
create table standup_away (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references users (id) on delete cascade,
    starts_on date not null,
    ends_on date not null,
    created_at timestamptz not null default now(),
    check (ends_on >= starts_on),
    check (ends_on - starts_on < 90)
);

create index standup_away_user_idx on standup_away (user_id, ends_on);
