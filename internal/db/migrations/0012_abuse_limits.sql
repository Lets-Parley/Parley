-- Hourly open-mode identity creation counters retain only a one-way digest of
-- the verified client address. Old buckets are removed opportunistically by
-- the creation transaction after they are no longer part of the active window.
create table identity_creation_buckets (
    bucket_start timestamptz not null,
    client_digest bytea not null,
    count integer not null check (count > 0),
    primary key (bucket_start, client_digest)
);

create table identity_creation_global_buckets (
    bucket_start timestamptz primary key,
    count integer not null check (count > 0)
);

-- Existing spaces remain fully usable. Only spaces created after this version
-- participate in the per-identity creation quota.
alter table spaces add column creator_id uuid references users (id);
create index spaces_creator_id_idx on spaces (creator_id) where creator_id is not null;
