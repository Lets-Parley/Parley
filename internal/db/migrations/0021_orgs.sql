-- Spaces gain a home. An org sits above spaces: users belong to orgs, and a
-- space belongs to exactly one org. Org membership is deliberately not space
-- membership — it says which directory you can see, not which room you are in.
--
-- Schema only. Nothing reads visibility or org_members yet; the routes,
-- middleware and directory behavior land in later phases.

create table orgs (
    id uuid primary key default gen_random_uuid(),
    slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$' or slug ~ '^[a-z0-9]$'),
    name text not null check (char_length(name) between 1 and 64),
    -- The identity-provider claim value that maps a token to this org. It is
    -- unique, and it may not be empty: an empty value would match every token
    -- that simply lacks the claim, handing org membership to everyone.
    claim_value text not null unique check (claim_value <> ''),
    created_at timestamptz not null default now()
);

create table org_members (
    org_id uuid not null references orgs (id) on delete cascade,
    user_id uuid not null references users (id) on delete cascade,
    role text not null default 'member' check (role in ('admin', 'member')),
    -- Revocation is a stamp rather than a delete, so custody history survives
    -- someone being removed and re-added.
    revoked_at timestamptz,
    created_at timestamptz not null default now(),
    primary key (org_id, user_id)
);

-- The default org carries a fixed id rather than a generated one because
-- spaces.org_id below needs it as a literal column default, and a subquery is
-- not a legal default expression.
insert into orgs (id, slug, name, claim_value)
values ('00000000-0000-0000-0000-000000000001', 'default', 'Default', 'default')
on conflict (id) do nothing;

alter table spaces add column org_id uuid references orgs (id) on delete restrict;

-- 'private' at the column, so an upgrade discloses exactly what it disclosed
-- yesterday: a stranger with the link still learns the name and whether a
-- passcode is set, and nothing more. New spaces get their visibility set
-- explicitly by Spaces.Create instead.
alter table spaces add column visibility text not null default 'private'
    check (visibility in ('private', 'org'));

update spaces set org_id = '00000000-0000-0000-0000-000000000001' where org_id is null;

-- `link_id is null` is the whole security of this statement. Since 0018 a
-- redeemed signed link mints an ordinary users row carrying link_id: a
-- capability on one room, not an account. Without the filter, every person
-- ever handed a guest link becomes an org member with directory visibility.
insert into org_members (org_id, user_id, role)
select '00000000-0000-0000-0000-000000000001', id, 'member' from users where link_id is null
on conflict (org_id, user_id) do nothing;

-- The default is retained for one release: a replica still running the
-- previous binary inserts spaces without org_id for the length of a rolling
-- update, and a NOT NULL column with no default would fail every one of them.
alter table spaces alter column org_id set default '00000000-0000-0000-0000-000000000001';
alter table spaces alter column org_id set not null;

-- A slug is a name inside one org, not across the instance.
alter table spaces drop constraint spaces_slug_key;
alter table spaces add constraint spaces_org_id_slug_key unique (org_id, slug);
