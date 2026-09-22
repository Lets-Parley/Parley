-- A space's recurring async standup. One schedule per space; editing it
-- changes future slots only, since the open slot's session is its own row.
create table standup_schedules (
    id             uuid primary key default gen_random_uuid(),
    space_id       uuid not null unique references spaces(id) on delete cascade,
    -- time.Weekday numbering: 0 is Sunday.
    weekdays       smallint[] not null
        check (cardinality(weekdays) > 0 and weekdays <@ '{0,1,2,3,4,5,6}'::smallint[]),
    open_time      time not null,
    timezone       text not null,
    window_minutes integer not null check (window_minutes between 1 and 1440),
    enabled        boolean not null default true,
    -- The user who last saved it. Null when that user has been deleted: the
    -- schedule stays, and a slot falls back to a current owner at open time.
    updated_by     uuid references users(id) on delete set null,
    updated_at     timestamptz not null default now()
);

-- One row per slot that has opened. The primary key is the whole
-- cross-replica story: every ticker inserts, and exactly one insert wins.
-- session_id is set null rather than cascaded so deleting a slot's room does
-- not let the same local day open again.
create table standup_schedule_slots (
    schedule_id uuid not null references standup_schedules(id) on delete cascade,
    slot_date   date not null,
    session_id  uuid references sessions(id) on delete set null,
    primary key (schedule_id, slot_date)
);
