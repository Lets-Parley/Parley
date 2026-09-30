-- Verified .parley bundles, stored whole so every replica serves identical
-- bytes. Append-only: a row is written once and never updated or deleted.
--
-- The digest covers content, not who signed it, so the key is (digest,
-- key_id): the same bytes re-signed by another key are a second row. key_id
-- is '' for an unsigned bundle accepted under PLUGIN_ALLOW_UNSIGNED, never
-- null, so it can sit in the primary key.
create table plugin_bundles (
    digest      text not null,
    key_id      text not null,
    name        text not null,
    version     text not null,
    manifest    jsonb not null,
    wasm        bytea not null,
    ui          bytea,
    slots       bytea,
    uploaded_by uuid references users (id) on delete set null,
    uploaded_at timestamptz not null default now(),
    primary key (digest, key_id)
);

create index plugin_bundles_name_version_idx on plugin_bundles (name, version, uploaded_at desc);
