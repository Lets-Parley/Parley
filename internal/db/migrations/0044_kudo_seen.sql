-- seen_at is when a kudo's recipient put the letter with the others. It is per
-- kudo, and it is the recipient's alone: the API shows it only to them, as an
-- unread flag, and never to the sender. It is never aggregated and never
-- exported — a "read by" count is the leaderboard 0033_kudos.sql refuses,
-- arriving by a side door.
--
-- No default: an old binary's insert names its columns during a rolling
-- deploy, and a new kudo correctly starts unread (null).
alter table kudos add column seen_at timestamptz null;

-- An upgrade must not deliver years of old letters at once.
update kudos set seen_at = now() where seen_at is null;
