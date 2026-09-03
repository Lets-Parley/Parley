-- An upgrade that asks for more than the operator already approved must not
-- get it by arriving. The requested version and its grants park here until an
-- operator approves them, and the install keeps running on the version and the
-- grants it already had.
--
-- Storing the request rather than applying it is the whole point: a plugin
-- that could widen its own capabilities by publishing a new bundle would make
-- the grant model advisory.
alter table plugin_installs add column pending_version text;

create table plugin_pending_grants (
    install_id   uuid not null references plugin_installs (id) on delete cascade,
    capability   text not null,
    scope        text not null default '',
    requested_at timestamptz not null default now(),
    primary key (install_id, capability, scope)
);
