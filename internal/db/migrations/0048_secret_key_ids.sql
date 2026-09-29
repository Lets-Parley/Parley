-- Which key sealed each secret: a truncated HMAC fingerprint of the key, never
-- the key. Null marks the unbound form every secret is written in until an
-- operator runs "parley secrets reseal": no additional data, readable by the
-- binaries from before this migration.
alter table plugin_secrets add column key_id text;
alter table standup_webhooks add column key_id text;

-- One row, written by "parley secrets reseal" once every replica can read the
-- bound form. Until it exists, secrets are written unbound; after it, bound.
create table secret_binding (
    singleton boolean primary key default true check (singleton),
    bound_at  timestamptz not null default now()
);
