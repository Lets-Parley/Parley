-- A readiness signal for the gathering phase: the facilitator can see who has
-- finished writing before starting the round. It is advisory — nothing in the
-- speaking order, the skip logic or the CSV reads it.
--
-- Existing rows default to not-ready, which is the honest answer: nobody in a
-- standup that predates this column ever said they were ready. No backfill.
-- The default is constant, so on PostgreSQL 11+ this rewrites no heap and the
-- ACCESS EXCLUSIVE lock is held for microseconds.
alter table standup_entries add column ready bool not null default false;
