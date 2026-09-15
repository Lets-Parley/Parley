alter table users
    add column notification_sounds boolean not null default false;

alter table sessions
    add column poker_round_version bigint not null default 0;
