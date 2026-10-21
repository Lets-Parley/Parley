-- answer is the recipient's one short line back to a kudo. A kudo has zero or
-- one answer — the column is on the kudo, not a table of replies — so answers
-- can never be counted, threaded or ranked: there is no leaderboard here, as
-- 0033_kudos.sql says. Withdrawing a kudo deletes its row, and the answer goes
-- with it. Answers are never exported.
--
-- Nullable, no default: an old binary's insert names its columns during a
-- rolling deploy, and a new kudo is correctly unanswered.
alter table kudos
  add column answer text null check (char_length(answer) between 1 and 80),
  add column answered_at timestamptz null;
