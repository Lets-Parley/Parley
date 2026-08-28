-- The org directory's sort key. Spaces.ForOrg pages by keyset —
-- order by (name, slug), resumed with `(name, slug) > (…, …)` — so this index
-- turns each page into a range scan from the cursor instead of a sort of the
-- whole org. The slug column is in the key because names are not unique inside
-- an org: without it the cursor could not name a single row.
--
-- Partial on archived_at is null because the directory never shows an archived
-- space, and an org that has archived a year of rooms should not be paying for
-- them on every page.
--
-- The visibility half of the where clause is deliberately not in here. The
-- query is org-visible spaces *or* ones the caller belongs to, so neither
-- value can be filtered out before the members join runs.
--
-- create index concurrently cannot run inside a transaction and migrate.go
-- wraps each file in one, so this is a regular create index, applied by one
-- replica behind the migration advisory lock.

create index spaces_org_directory_idx
    on spaces (org_id, name, slug)
    where archived_at is null;
