-- The embedded session: Parley inside a meeting client's side panel.
--
-- A handoff is one sign-in attempt from a framed page. The frame holds a
-- random verifier and sends only its S256 digest (challenge_hash); a person
-- signed in to Parley in a top-level tab binds the row to themselves, and the
-- frame then trades the verifier for a session token once. display_code is
-- shown on both sides so the person can check they are binding their own
-- request. Rows are short-lived (expires_at) and swept with session tokens.
create table embed_handoffs (
    challenge_hash bytea primary key check (octet_length(challenge_hash) = 32),
    display_code text not null,
    provider text not null,
    client_key text not null,
    user_id uuid references users (id) on delete cascade,
    created_at timestamptz not null default now(),
    expires_at timestamptz not null,
    bound_at timestamptz,
    used_at timestamptz
);

create index embed_handoffs_expires_at_idx on embed_handoffs (expires_at);
create index embed_handoffs_client_key_idx on embed_handoffs (client_key, created_at);

-- A token minted through a handoff. It carries participant power only: the
-- api refuses it on the admin set, link minting and identity rotation.
alter table session_tokens add column embedded boolean not null default false;
