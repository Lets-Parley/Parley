-- A space's outbound webhook for standup events. One per space. The signing
-- secret is stored sealed with the instance's PLUGIN_SECRET_KEY: it has to be
-- recoverable to sign, so it cannot be a hash.
create table standup_webhooks (
    space_id          uuid primary key references spaces(id) on delete cascade,
    url               text not null,
    secret_nonce      bytea not null,
    secret_ciphertext bytea not null,
    -- Only sessions and cutoffs after this instant produce events, so
    -- configuring a webhook does not replay a space's history into it.
    created_at        timestamptz not null default now(),
    updated_by        uuid references users(id) on delete set null
);

-- The outbox. The id is the event id a receiver sees, stable across retries;
-- the unique key is what keeps every replica's sweep from minting a second
-- event for the same session and event type. A deleted room takes its
-- undelivered events with it.
create table standup_webhook_deliveries (
    id              uuid primary key default gen_random_uuid(),
    space_id        uuid not null references spaces(id) on delete cascade,
    session_id      uuid not null references sessions(id) on delete cascade,
    event           text not null
        check (event in ('standup.opened', 'standup.closed', 'standup.ended')),
    attempts        integer not null default 0,
    next_attempt_at timestamptz not null default now(),
    lease_until     timestamptz,
    delivered_at    timestamptz,
    failed_at       timestamptz,
    last_error      text,
    created_at      timestamptz not null default now(),
    unique (session_id, event)
);

create index standup_webhook_deliveries_due_idx
    on standup_webhook_deliveries (next_attempt_at)
    where delivered_at is null and failed_at is null;
