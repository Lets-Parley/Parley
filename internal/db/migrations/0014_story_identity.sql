-- A ticket is named by its reference, by its title, or by both, and any one of
-- those is a whole ticket. The original table demanded a title of at least one
-- character, which made a reference-only ticket unstorable once 0007 added the
-- ref column. The length caps are the part worth keeping, so the title check is
-- replaced by a cap alone and the "it has to be called something" invariant
-- moves to a constraint that reads both columns.
--
-- Every existing row already has a title of at least one character, so both new
-- constraints hold on the way in and neither needs a backfill.
alter table stories
    drop constraint stories_title_check,
    add constraint stories_title_check check (char_length(title) <= 200),
    add constraint stories_identified_check check (title <> '' or ref <> '');
