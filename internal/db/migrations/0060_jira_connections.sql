-- One Jira connection per org. The client secret is sealed; the row holds
-- no issue body and no access token. A space's write switch defaults off,
-- so a saved credential publishes nothing until that space's owner turns it on.
create table jira_connections (
    id uuid primary key,
    org_id uuid not null unique references orgs (id) on delete cascade,
    cloud_id text not null,
    field_id text not null,
    client_id text not null,
    generation uuid not null,
    nonce bytea not null,
    ciphertext bytea not null,
    key_id text not null,
    constraint jira_connections_field_id_check check (field_id ~ '^customfield_[0-9]+$')
);

alter table spaces
    add column jira_write_enabled boolean not null default false;
