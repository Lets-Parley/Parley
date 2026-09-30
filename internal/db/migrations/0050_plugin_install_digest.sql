-- An install names the exact bundle it runs, not just a name and version.
--
-- bundle_digest/bundle_key_id pin the plugin_bundles row the host loads;
-- pending_* stage the row a widening upgrade or rollback is waiting to move
-- to. All four are nullable for one release: an install made before the
-- catalogue has no row to point at and keeps running from PLUGIN_DIR's loose
-- files, shown as "not in catalogue". A later migration makes the pin NOT NULL.
alter table plugin_installs
    add column bundle_digest  text,
    add column bundle_key_id  text,
    add column pending_digest text,
    add column pending_key_id text,
    add constraint plugin_installs_bundle_fkey
        foreign key (bundle_digest, bundle_key_id) references plugin_bundles (digest, key_id),
    add constraint plugin_installs_pending_bundle_fkey
        foreign key (pending_digest, pending_key_id) references plugin_bundles (digest, key_id);

-- Every bundle an install has been pinned to. A rollback may only name one of
-- these: "a digest this install previously ran" is a row here, never a guess.
create table plugin_install_history (
    install_id uuid not null references plugin_installs (id) on delete cascade,
    digest     text not null,
    key_id     text not null,
    pinned_at  timestamptz not null default now(),
    primary key (install_id, digest, key_id),
    foreign key (digest, key_id) references plugin_bundles (digest, key_id)
);
