alter table stories
    add column scope_revision bigint not null default 0 check (scope_revision >= 0),
    add column accepted_scope_revision bigint check (accepted_scope_revision >= 0),
    add column accepted_round_version bigint check (accepted_round_version >= 0),
    add column estimate_provenance text check (estimate_provenance in ('historical', 'facilitator-set', 'poker'));

update stories set accepted_scope_revision=0, estimate_provenance='historical'
where estimate is not null;
