-- A person's self-set away days, for async standups. Each row is an inclusive
-- range of calendar dates. It belongs to the user rather than to a space: a
-- week off is a week off in every team someone stands up with.
--
-- An away person is left out of today's open digest "not yet" list and out of
-- the eligible count of a trend day frozen while the range covered it. Nothing
-- here, and nothing read from here, computes participation per person.
--
-- created_at matters: a range counts for a day only if it was created before
-- that day was over, so setting one on a past day changes no frozen count.
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

-- One frozen trend day per scheduled async standup: how many people were
-- eligible to answer it and how many of those did, counted once when the
-- day was over and never again. The team trend sums these rows and nothing
-- else, so a later change of membership, spectator flag or away range cannot
-- move a day that has already been counted, and two readings of the trend
-- can never be differenced into one person.
--
-- Only a standup a schedule opened (one named by standup_schedule_slots) is
-- ever frozen. session_id is set null rather than cascaded, so deleting the
-- room does not take its day out of a week that was already shown; the
-- unique index still admits exactly one row per live session, which is what
-- makes the first write the only one.
create table standup_trend_days (
    id uuid primary key default gen_random_uuid(),
    session_id uuid unique references sessions (id) on delete set null,
    space_id uuid not null references spaces (id) on delete cascade,
    day date not null,
    eligible integer not null check (eligible >= 0),
    answered integer not null check (answered >= 0 and answered <= eligible),
    frozen_at timestamptz not null default now()
);

create index standup_trend_days_space_idx on standup_trend_days (space_id, day);
