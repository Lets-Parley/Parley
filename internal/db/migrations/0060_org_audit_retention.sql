-- How long an org keeps its audit log. Null means forever, which is what
-- every org did before this column existed, so an upgrade deletes nothing.
-- The API only ever writes 30, 90 or 365; the check is the floor beneath it.
alter table orgs
    add column audit_retention_days integer check (audit_retention_days > 0);

-- The prune walks each org's rows by age. Records orphaned by a purge
-- (org_id null) are never pruned and never touch this index's useful part.
create index org_audit_log_org_id_created_idx on org_audit_log (org_id, created_at)
    where org_id is not null;
