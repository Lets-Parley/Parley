-- A story either points at a ticket in whatever tracker the team already uses,
-- or it is an ad-hoc round with nothing behind it. Empty string is the ad-hoc
-- case, so the column stays non-null and every existing row is already correct.
alter table stories
    add column ref text not null default '' check (char_length(ref) <= 40);
