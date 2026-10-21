create table poker_publication_connections (
 id uuid primary key default gen_random_uuid(),
 org_id uuid not null references orgs(id) on delete cascade,
 space_id uuid not null references spaces(id) on delete cascade,
 session_id uuid not null references sessions(id) on delete cascade,
 principal_id uuid not null references users(id) on delete cascade,
 generation uuid not null default gen_random_uuid(),
 config jsonb not null,
 nonce bytea not null,
 ciphertext bytea not null,
 key_id text not null,
 unique (org_id,space_id,session_id,principal_id)
);
