-- Active org memberships looked up by user. The primary key is (org_id,
-- user_id), which serves "is this user in this org" by prefix but cannot help
-- the queries that ask "which orgs is this user in" — Orgs.ForUser (org
-- switcher and landing grouping) and Spaces.OrgSlugsForMemberSpaceSlug.
--
-- Every one of those filters revoked_at is null. The admin members screen
-- lists by org_id and includes revoked rows, so it does not need this index
-- and a partial form stays small.
--
-- create index concurrently cannot run inside a transaction, and
-- migrate.go wraps each migration file in one, so this is a regular
-- create index. Boot serialises behind the migration advisory lock, so the
-- short AccessExclusiveLock during the build is held only while that one
-- replica applies the file.

create index org_members_user_active_idx
    on org_members (user_id)
    where revoked_at is null;
