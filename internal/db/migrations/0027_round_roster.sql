-- Who a round is waiting for, recorded when the round opens.
--
-- An open round is estimated asynchronously, so it cannot be gated on who is
-- connected at the moment the last vote lands. Reading the eligible set live
-- from the space does not work either: a forty-member space would never
-- complete a five-person round, and a link guest — who has no members row —
-- would sit outside the set entirely. So the expected voters are snapshotted
-- the moment the story goes on the table, and the round waits for exactly
-- those people however long that takes.
--
-- Rows are only written for a session with openVoting on; a closed round
-- still counts the connected set and never touches this table.
create table round_voters (
    story_id uuid not null references stories (id) on delete cascade,
    user_id uuid not null references users (id) on delete cascade,
    primary key (story_id, user_id)
);
