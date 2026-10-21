alter table poker_publication_steps drop constraint poker_publication_steps_kind_check;
alter table poker_publication_steps add constraint poker_publication_steps_kind_check
    check(kind in ('create','parent','dependency','remove-dependency','project','estimate'));
