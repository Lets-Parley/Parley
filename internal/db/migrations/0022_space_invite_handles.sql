-- An invite handle is an opaque capability that stands in for a space passcode
-- for the length of one sign-in round trip. Accepting an invite under an
-- identity provider is a full-page navigation away and back, and the passcode
-- rides in a URL fragment that does not survive it; the handle is what waits
-- in the browser instead, so the code itself never has to.
--
-- Same shape as session_links (0018): the handle is never stored, only its
-- sha256 digest, so a database leak hands out no working handles. It is bound
-- to exactly one space, and it cascades with it — a deleted space cannot leave
-- a live capability on nothing behind.
--
-- Redemption deletes the row rather than stamping it. That makes single use a
-- property of the statement rather than of the code around it: two requests
-- racing on one handle both run the same DELETE, the second blocks on the row
-- lock, re-reads, and finds nothing to delete. It also means a spent handle
-- needs no sweeping, and only abandoned ones ever age out.
create table space_invite_handles (
    token_hash bytea primary key,
    space_id uuid not null references spaces (id) on delete cascade,
    expires_at timestamptz not null,
    created_at timestamptz not null default now()
);

create index space_invite_handles_expires_at_idx on space_invite_handles (expires_at);
