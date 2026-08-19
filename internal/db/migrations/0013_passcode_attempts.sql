-- Passcode guessing is counted in the database so every replica spends from the
-- same budget. The row keeps only a one-way digest of the client address and
-- the space it knocked on. Expired rows are removed opportunistically by the
-- statement that charges the next attempt.
create table passcode_attempts (
    client_digest bytea primary key,
    attempts integer not null check (attempts >= 0),
    window_start timestamptz not null
);

create index passcode_attempts_window_start_idx on passcode_attempts (window_start);
