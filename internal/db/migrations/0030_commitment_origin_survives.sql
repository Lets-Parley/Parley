-- Deleting the room a commitment was opened in must not destroy it.
--
-- opened_session_id was `not null ... on delete cascade`, so deleting the
-- origin room deleted the commitment outright — including an open one still on
-- somebody's carry-over list. The person lost the item with no trace and no
-- notice. This is the sibling of the closed_session_id case 0028 already
-- reasons about: the work belongs to the (space_id, user_id), not to the room
-- it happened to be typed in.
--
-- So the column joins closed_session_id and carried_session_id as historical
-- linkage only: nullable, on delete set null. A null reads as "opened in a room
-- that no longer exists", which is honest and is the only new state — the
-- commitment stays open, stays on the list, and stays answerable. The one
-- derived value, openedHere, is false for it, which is exactly right: there is
-- no origin room left for it to have been opened in.
alter table standup_commitments
    drop constraint standup_commitments_opened_session_id_fkey,
    alter column opened_session_id drop not null,
    add constraint standup_commitments_opened_session_id_fkey
        foreign key (opened_session_id) references sessions (id) on delete set null;
