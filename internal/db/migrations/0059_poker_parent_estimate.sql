do $$
declare
    provenance_check text;
begin
    for provenance_check in
        select conname from pg_constraint
        where conrelid = 'stories'::regclass and contype = 'c'
          and pg_get_constraintdef(oid) like '%estimate_provenance%'
    loop
        execute format('alter table stories drop constraint %I', provenance_check);
    end loop;
end $$;

alter table stories
    add constraint stories_estimate_provenance_check
        check (estimate_provenance in ('historical', 'facilitator-set', 'poker', 'story-total')),
    add column parent_estimate_answered_revision bigint check (parent_estimate_answered_revision >= 0);
