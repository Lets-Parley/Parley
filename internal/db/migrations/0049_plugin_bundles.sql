-- Verified .parley bundles, stored whole so every replica serves identical
-- bytes. Append-only: a row is written once and never updated or deleted.
--
-- archive is the original .parley file and the only authority: every replica
-- re-verifies it against its own trust set before using it. The other content
-- columns are derived conveniences, and key_id is an index, never a grant.
--
-- The digest covers content, not who signed it, so the key is (digest,
-- key_id). key_id is '' for an unsigned bundle accepted under
-- PLUGIN_ALLOW_UNSIGNED, never null, so it can sit in the primary key.
create table plugin_bundles (
    digest      text not null,
    key_id      text not null,
    name        text not null,
    version     text not null,
    archive     bytea not null,
    manifest    jsonb not null,
    wasm        bytea not null,
    ui          bytea,
    slots       bytea,
    uploaded_by uuid references users (id) on delete set null,
    uploaded_at timestamptz not null default now(),
    primary key (digest, key_id)
);

-- One publisher per name and version: the first signed bundle wins, and at
-- most one unsigned bundle exists, only where it came first. A signed bundle
-- is always preferred over it.
create unique index plugin_bundles_signed_name_version on plugin_bundles (name, version) where key_id <> '';
create unique index plugin_bundles_unsigned_name_version on plugin_bundles (name, version) where key_id = '';
