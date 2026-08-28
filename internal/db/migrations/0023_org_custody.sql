-- Org custody: an org admin can manage any space in the org, including private
-- ones, without being able to read anything said inside them. Two things are
-- needed for that to be more than a promise — somewhere to park a space that
-- is no longer in use, and a record of the one action that does hand an admin
-- a way in.

-- Archiving is housekeeping, not deletion: an archived space keeps its slug,
-- its history and its members, and simply stops being listed in the org
-- directory. Nullable, because "not archived" is the normal state and a
-- timestamp says when it happened without a second boolean to disagree with.
alter table spaces add column archived_at timestamptz;

-- The audit log. It exists for exactly one reason: claiming an abandoned space
-- is the only path by which an org admin becomes a member of a space they were
-- not in, and an escalation nobody can review afterwards is not a control.
--
-- Neither foreign key cascades, and both are nullable. The org purge below
-- deletes an org's spaces and then the org itself; if these rows went with
-- them, the record of what an admin did would be erased by the very action
-- most worth recording. The slugs are stored denormalized as text so a row
-- whose ids have been nulled still names what it happened to.
create table org_audit_log (
    id uuid primary key default gen_random_uuid(),
    org_id uuid references orgs (id) on delete set null,
    org_slug text not null,
    space_id uuid references spaces (id) on delete set null,
    space_slug text not null default '',
    -- The account that took the action. Also 'set null': deleting a person's
    -- account must not silently rewrite history, and the log is about what was
    -- done to a space, not about who is still on the instance.
    actor_id uuid references users (id) on delete set null,
    action text not null check (action <> ''),
    -- Human-readable context for the action; never session content.
    detail text not null default '',
    created_at timestamptz not null default now()
);

-- Reading the log is always "what happened in this org, most recent first",
-- and org_slug rather than org_id is the key because it is the column that
-- survives the org being purged.
create index org_audit_log_org_idx on org_audit_log (org_slug, created_at desc);
