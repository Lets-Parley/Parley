-- The tables a plugin host needs before any plugin code exists.
--
-- Nothing here runs a plugin. This is the durable shape the host will consume:
-- what is installed, what it is allowed to do, what it has stored, and the
-- outbox and job queue that carry work to it.

-- What is installed. kv_bytes is a counter, not a view: the key-value writes
-- maintain it in the same statement as the write it accounts for, so a quota
-- check never reads a number that a concurrent write has already invalidated.
-- A reconciliation pass corrects drift, because a counter that can drift
-- silently grants unbounded storage.
create table plugin_installs (
    id             uuid primary key default gen_random_uuid(),
    name           text not null unique,
    version        text not null,
    enabled        boolean not null default true,
    kv_bytes       bigint not null default 0 check (kv_bytes >= 0),
    kv_quota_bytes bigint not null check (kv_quota_bytes >= 0),
    created_at     timestamptz not null default now()
);

-- What each install is allowed to do. A capability with no scope is the whole
-- capability; a scope narrows it — "events" scoped to one topic is also how a
-- plugin subscribes, which is why there is no separate subscription table.
create table plugin_grants (
    install_id uuid not null references plugin_installs (id) on delete cascade,
    capability text not null,
    scope      text not null default '',
    granted_at timestamptz not null default now(),
    primary key (install_id, capability, scope)
);

-- Secrets are stored encrypted or not at all. There is deliberately no
-- plaintext column: an install that asks for the secrets capability with no
-- key configured is refused rather than degraded.
create table plugin_secrets (
    install_id uuid not null references plugin_installs (id) on delete cascade,
    name       text not null,
    nonce      bytea not null,
    ciphertext bytea not null,
    updated_at timestamptz not null default now(),
    primary key (install_id, name)
);

-- Namespaced key-value storage. A plugin has no SQL, so this is the whole of
-- its durable storage. size_bytes is what the quota counter is made of.
create table plugin_kv (
    install_id uuid not null references plugin_installs (id) on delete cascade,
    key        text not null,
    value      bytea not null,
    size_bytes integer not null check (size_bytes >= 0),
    updated_at timestamptz not null default now(),
    primary key (install_id, key)
);

-- The transactional outbox. Core subscribers are in-process and synchronous;
-- plugin subscribers get a row here, written inside the same transaction as
-- the state change, and a worker drains it. Delivery is therefore at-least-
-- once and handlers must be idempotent.
create table plugin_events (
    id         bigserial primary key,
    topic      text not null,
    payload    jsonb not null,
    created_at timestamptz not null default now()
);

-- Retention is here from day one. An outbox that never prunes is an unbounded
-- table on a single-container deploy, and adding retention once the table is
-- large means a migration under load.
create index plugin_events_created_at_idx on plugin_events (created_at);

-- One row per (event, subscriber). dead is the terminal state a delivery
-- reaches after a bounded number of attempts, so a permanently failing
-- subscriber stops starving live deliveries behind it.
create table plugin_deliveries (
    id           bigserial primary key,
    event_id     bigint not null references plugin_events (id) on delete cascade,
    install_id   uuid not null references plugin_installs (id) on delete cascade,
    state        text not null default 'pending' check (state in ('pending', 'delivered', 'dead')),
    attempts     integer not null default 0,
    last_error   text,
    available_at timestamptz not null default now(),
    updated_at   timestamptz not null default now(),
    unique (event_id, install_id)
);

-- The claim order: pending work that is due, oldest first.
create index plugin_deliveries_claim_idx on plugin_deliveries (available_at) where state = 'pending';

-- Deferred work. Cron triggering is deliberately not here yet; run_at is the
-- whole scheduling vocabulary for now.
create table plugin_jobs (
    id         bigserial primary key,
    install_id uuid references plugin_installs (id) on delete cascade,
    kind       text not null,
    payload    jsonb not null default '{}'::jsonb,
    state      text not null default 'pending' check (state in ('pending', 'done', 'dead')),
    attempts   integer not null default 0,
    last_error text,
    run_at     timestamptz not null default now(),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index plugin_jobs_claim_idx on plugin_jobs (run_at) where state = 'pending';
