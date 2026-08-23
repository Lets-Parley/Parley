-- A guest's identity is link-bound only for as long as its session_links row
-- exists: users.link_id is `on delete set null` (0018, deliberately not
-- cascade, so a deleted room never erases the votes cast in it), and the
-- principal resolver reads the binding through that column. Deleting a room or
-- a space cascade-deletes its links, which left the guest holding a live
-- session_tokens row whose user no longer read as a link guest at all — an
-- ordinary account that RequireUser admits and that POST /api/me will rename
-- and re-token with no absolute expiry.
--
-- Revoking a link already deletes the sessions it opened, in Links.Revoke. This
-- does the same for every other way a link can disappear, cascades included,
-- where no Go code runs at all. The token rows go; the users, their votes and
-- their standup entries stay exactly where they were.
--
-- It must be BEFORE DELETE: the `on delete set null` action runs as an internal
-- after-row trigger, so by AFTER DELETE the link_id this reads may already be
-- null.
create function session_link_tokens_delete() returns trigger
language plpgsql as $$
begin
    delete from session_tokens st
     using users u
     where u.link_id = old.id and st.user_id = u.id;
    return old;
end;
$$;

create trigger session_links_delete_tokens
    before delete on session_links
    for each row execute function session_link_tokens_delete();
