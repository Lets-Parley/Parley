-- A signed link is an opaque capability token bound to exactly one room. The
-- token itself is never stored: only its sha256 digest, the same shape
-- session_tokens uses, so a database leak hands out no working links.
create table session_links (
    id uuid primary key default gen_random_uuid(),
    session_id uuid not null references sessions (id) on delete cascade,
    created_by uuid not null references users (id),
    token_hash bytea not null unique,
    expires_at timestamptz not null,
    revoked_at timestamptz,
    redemptions int not null default 0 check (redemptions >= 0),
    created_at timestamptz not null default now()
);

create index session_links_session_idx on session_links (session_id, created_at desc);

-- A link-bound user is exactly a user with this set; redemption (a later
-- phase) mints an ordinary users row and stamps it here, so presence, the hub,
-- story identity and CSV attribution need no second code path.
--
-- `on delete set null`, deliberately not cascade: poker votes, standup entries
-- and presence all cascade from users, so cascading here would make deleting a
-- room or revoking a link erase a guest's contributions from a finished
-- meeting and from any CSV exported afterwards. The link row goes; the person
-- and their work stay.
alter table users add column link_id uuid references session_links (id) on delete set null;

create index users_link_id_idx on users (link_id) where link_id is not null;
