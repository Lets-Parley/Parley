alter table stories
    add column parent_id uuid,
    add column planning_role text not null default 'planning'
        check (planning_role in ('planning', 'proposed', 'context')),
    add column content_revision bigint not null default 0 check (content_revision >= 0),
    add column split_revision bigint not null default 0 check (split_revision >= 0),
    add column creation_operation text,
    add column creation_payload jsonb,
    add column removed_at timestamptz,
    add column is_remainder boolean not null default false,
    add column coverage text check (coverage in ('full', 'remainder', 'needs-review')),
    add constraint stories_id_session_unique unique (id, session_id),
    add constraint stories_parent_session_fk foreign key (parent_id, session_id)
        references stories (id, session_id),
    add constraint stories_split_shape check (
        (parent_id is null and planning_role <> 'proposed' and not is_remainder)
        or (parent_id is not null and parent_id <> id and planning_role <> 'context'
            and char_length(btrim(title)) > 0 and coverage is null)),
    add constraint stories_operation_pair check ((creation_operation is null) = (creation_payload is null)),
    add constraint stories_operation_length check (char_length(creation_operation) between 1 and 100);

create unique index stories_creation_operation_idx on stories (session_id, creation_operation)
    where creation_operation is not null;
create index stories_children_idx on stories (parent_id, position) where parent_id is not null;
