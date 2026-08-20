-- Space membership gains a role so somebody can manage the room. 'owner' may
-- promote, demote and remove; 'member' may not. The vocabulary is constrained
-- here rather than only in Go: a role is an authorization decision, and a
-- typo'd value must not be storable at all.
alter table members add column role text not null default 'member'
    check (role in ('owner', 'member'));

-- Backfill, pass one: every space that recorded its creator hands them the
-- room. creator_id arrived in 0012 and is still nullable, so this cannot
-- cover every space on its own.
update members m
set role = 'owner'
from spaces s
where s.id = m.space_id
  and s.creator_id = m.user_id;

-- Backfill, pass two: a space with no recorded creator (or whose creator has
-- since left) would otherwise come out of this migration ownerless, and an
-- ownerless space can never be managed by anyone again. The longest-standing
-- member takes it; user_id breaks a tie so the result does not depend on scan
-- order.
update members m
set role = 'owner'
where m.role <> 'owner'
  and not exists (
      select 1 from members o
      where o.space_id = m.space_id and o.role = 'owner'
  )
  and (m.last_seen_at, m.user_id) = (
      select e.last_seen_at, e.user_id
      from members e
      where e.space_id = m.space_id
      order by e.last_seen_at, e.user_id
      limit 1
  );

create index members_owner_idx on members (space_id) where role = 'owner';
