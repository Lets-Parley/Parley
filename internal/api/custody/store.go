package custody

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrNoSpace = errors.New("no such space")
	// ErrNotAMember covers both "not a member of this space" and "not a member
	// of this org": every caller of it already knows which question it asked.
	ErrNotAMember = errors.New("not a member")
	// ErrNotAbandoned refuses a claim on a space somebody is still in.
	ErrNotAbandoned = errors.New("this space still has members")
	// ErrLastAdmin is the org-level counterpart of store.ErrLastOwner.
	ErrLastAdmin = errors.New("the last org admin cannot be demoted or revoked")
	// ErrWouldStrandSpace reports that a revoke would leave at least one space
	// with no owner. The blocking slugs come back alongside it.
	ErrWouldStrandSpace     = errors.New("this would leave a space with no owner")
	ErrConfirmationRequired = errors.New("the org's slug is required to confirm")
)

// Store is custody's own view of the database. It deliberately does not reuse
// internal/store: linking that package in would put every session, presence
// and vote query one identifier away from a custody handler, which is exactly
// the boundary this phase exists to draw.
type Store struct {
	Pool *pgxpool.Pool

	// hooks are interruption points inside a purge, nil everywhere but this
	// package's own tests. A purge is one transaction with no seam an ordinary
	// input can reach into, and the states worth pinning — another session
	// committing a space mid-purge, the destructive half failing part-way —
	// exist only between its statements.
	hooks purgeHooks
}

// purgeHooks is test-only and unexported: nothing outside this package can
// name it, set it, or observe that it exists.
type purgeHooks struct {
	// afterCount runs after the preview count and before anything is
	// destroyed: the window in which another session's write used to go
	// unreported.
	afterCount func(context.Context) error
	// beforeOrgDelete runs after the spaces and the audit record, immediately
	// before the org row itself goes.
	beforeOrgDelete func(context.Context, pgx.Tx) error
}

// SpacesInOrg lists every space in the org, private and archived ones
// included, as metadata only.
func (s *Store) SpacesInOrg(ctx context.Context, orgID string) ([]CustodySpace, error) {
	rows, err := s.Pool.Query(ctx, `
		select sp.id, sp.slug, sp.name, sp.visibility, sp.archived_at,
		       count(m.user_id),
		       coalesce(array_agg(m.user_id::text) filter (where m.role = 'owner'), '{}')
		from spaces sp
		left join members m on m.space_id = sp.id
		where sp.org_id = $1
		group by sp.id
		order by sp.name`, orgID)
	if err != nil {
		return nil, fmt.Errorf("listing the org's spaces: %w", err)
	}
	defer rows.Close()
	spaces := []CustodySpace{}
	for rows.Next() {
		var sp CustodySpace
		if err := rows.Scan(&sp.ID, &sp.Slug, &sp.Name, &sp.Visibility, &sp.ArchivedAt, &sp.MemberCount, &sp.OwnerIDs); err != nil {
			return nil, fmt.Errorf("listing the org's spaces: %w", err)
		}
		spaces = append(spaces, sp)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("listing the org's spaces: %w", err)
	}
	return spaces, nil
}

// SpaceRef is the little a custody action needs to know about a space: enough
// to act on it and to name it in the audit log, and nothing else.
type SpaceRef struct {
	ID         string
	Slug       string
	Visibility string
}

// SpaceBySlug resolves a slug inside the org the caller is scoped to. The org
// id is part of the WHERE rather than checked afterwards, so a slug that
// exists in another org is simply not found.
func (s *Store) SpaceBySlug(ctx context.Context, orgID, slug string) (SpaceRef, error) {
	var sp SpaceRef
	err := s.Pool.QueryRow(ctx,
		"select id, slug, visibility from spaces where org_id = $1 and slug = $2", orgID, slug).
		Scan(&sp.ID, &sp.Slug, &sp.Visibility)
	if errors.Is(err, pgx.ErrNoRows) {
		return SpaceRef{}, ErrNoSpace
	}
	if err != nil {
		return SpaceRef{}, fmt.Errorf("reading a space: %w", err)
	}
	return sp, nil
}

// SpaceChange is a partial update: a nil field is left alone.
type SpaceChange struct {
	Name       *string
	Visibility *string
	Archived   *bool
}

// UpdateSpace applies a partial change. The org id rides along in the WHERE so
// a stale space id from another org cannot be written through this path.
func (s *Store) UpdateSpace(ctx context.Context, orgID, spaceID string, c SpaceChange) error {
	var archivedAt *time.Time
	if c.Archived != nil && *c.Archived {
		now := time.Now().UTC()
		archivedAt = &now
	}
	_, err := s.Pool.Exec(ctx, `
		update spaces set
			name = coalesce($3, name),
			visibility = coalesce($4, visibility),
			archived_at = case when $5::bool then $6 else archived_at end
		where id = $1 and org_id = $2`,
		spaceID, orgID, c.Name, c.Visibility, c.Archived != nil, archivedAt)
	if err != nil {
		return fmt.Errorf("updating a space: %w", err)
	}
	return nil
}

// DeleteSpace removes a space and everything under it — sessions, stories,
// standup rows, presence and memberships all cascade — and records that it
// happened. The audit row is written first and in the same transaction, so a
// deletion can never land without one.
func (s *Store) DeleteSpace(ctx context.Context, scope Scope, sp SpaceRef) error {
	return s.inTx(ctx, func(tx pgx.Tx) error {
		if err := audit(ctx, tx, scope, sp, "space.delete", ""); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, "delete from spaces where id = $1 and org_id = $2", sp.ID, scope.OrgID); err != nil {
			return fmt.Errorf("deleting a space: %w", err)
		}
		return nil
	})
}

// AddOwner promotes an existing member of the space. It is additive: the row
// lock is taken over the space's whole membership so the "is this person
// actually a member" answer cannot go stale between the check and the write,
// and no other member's role is touched.
func (s *Store) AddOwner(ctx context.Context, scope Scope, sp SpaceRef, userID string) error {
	return s.inTx(ctx, func(tx pgx.Tx) error {
		var role string
		err := tx.QueryRow(ctx,
			"select role from members where space_id = $1 and user_id = $2 for update", sp.ID, userID).Scan(&role)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotAMember
		}
		if err != nil {
			return fmt.Errorf("reading space membership: %w", err)
		}
		if role == roleOwner {
			return nil
		}
		if _, err := tx.Exec(ctx,
			"update members set role = $3 where space_id = $1 and user_id = $2", sp.ID, userID, roleOwner); err != nil {
			return fmt.Errorf("granting space ownership: %w", err)
		}
		return audit(ctx, tx, scope, sp, "space.add_owner", "granted ownership to "+userID)
	})
}

// ClaimSpace makes the acting admin the owner of a space nobody is left in.
//
// The space row is locked first so the emptiness check cannot be raced by a
// join: an empty membership set has no rows to lock, so locking `members`
// would guard nothing.
func (s *Store) ClaimSpace(ctx context.Context, scope Scope, sp SpaceRef) error {
	return s.inTx(ctx, func(tx pgx.Tx) error {
		var locked string
		if err := tx.QueryRow(ctx,
			"select id from spaces where id = $1 and org_id = $2 for update", sp.ID, scope.OrgID).Scan(&locked); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrNoSpace
			}
			return fmt.Errorf("locking a space: %w", err)
		}
		var remaining int
		if err := tx.QueryRow(ctx, "select count(*) from members where space_id = $1", sp.ID).Scan(&remaining); err != nil {
			return fmt.Errorf("counting space members: %w", err)
		}
		if remaining > 0 {
			return ErrNotAbandoned
		}
		if _, err := tx.Exec(ctx,
			"insert into members (space_id, user_id, role) values ($1, $2, $3)", sp.ID, scope.ActorID, roleOwner); err != nil {
			return fmt.Errorf("claiming a space: %w", err)
		}
		return audit(ctx, tx, scope, sp, "space.claim", "claimed an abandoned space")
	})
}

// OrgMembers lists the org's membership, revoked rows included: an admin
// cannot un-revoke somebody they cannot see.
func (s *Store) OrgMembers(ctx context.Context, orgID string) ([]OrgMember, error) {
	rows, err := s.Pool.Query(ctx, `
		select m.user_id, u.name, m.role, m.revoked_at
		from org_members m join users u on u.id = m.user_id
		where m.org_id = $1
		order by u.name`, orgID)
	if err != nil {
		return nil, fmt.Errorf("listing org members: %w", err)
	}
	defer rows.Close()
	members := []OrgMember{}
	for rows.Next() {
		var m OrgMember
		if err := rows.Scan(&m.UserID, &m.Name, &m.Role, &m.RevokedAt); err != nil {
			return nil, fmt.Errorf("listing org members: %w", err)
		}
		members = append(members, m)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("listing org members: %w", err)
	}
	return members, nil
}

// SetOrgRole promotes or demotes an org member, refusing to demote the last
// admin. The precedent is store.ErrLastOwner: an org nobody can administer can
// never be recovered, and that is true whether the demotion is aimed at
// somebody else or at oneself.
func (s *Store) SetOrgRole(ctx context.Context, orgID, userID, role string) error {
	return s.inTx(ctx, func(tx pgx.Tx) error {
		current, admins, err := lockOrgMembership(ctx, tx, orgID, userID)
		if err != nil {
			return err
		}
		if current == orgRoleAdmin && role != orgRoleAdmin && admins < 2 {
			return ErrLastAdmin
		}
		if _, err := tx.Exec(ctx,
			"update org_members set role = $3 where org_id = $1 and user_id = $2", orgID, userID, role); err != nil {
			return fmt.Errorf("setting an org role: %w", err)
		}
		return nil
	})
}

// lockOrgMembership reads the target's live role and the org's live admin
// count from one locked snapshot, so two admins demoting each other at the
// same instant cannot both see the other and both succeed. It is the same
// shape as store.Spaces.mutateMembership, one level up.
func lockOrgMembership(ctx context.Context, tx pgx.Tx, orgID, userID string) (string, int, error) {
	rows, err := tx.Query(ctx,
		"select user_id, role from org_members where org_id = $1 and revoked_at is null order by user_id for update", orgID)
	if err != nil {
		return "", 0, fmt.Errorf("locking org membership: %w", err)
	}
	var current string
	found := false
	admins := 0
	for rows.Next() {
		var id, role string
		if err := rows.Scan(&id, &role); err != nil {
			rows.Close()
			return "", 0, fmt.Errorf("reading org membership: %w", err)
		}
		if role == orgRoleAdmin {
			admins++
		}
		if id == userID {
			current, found = role, true
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return "", 0, fmt.Errorf("reading org membership: %w", err)
	}
	if !found {
		return "", admins, ErrNotAMember
	}
	return current, admins, nil
}

// RevokeOrgMember removes somebody from the org and from every space in it, in
// one transaction, and reports the spaces it removed them from as well as the
// spaces that block it.
//
// The removed ids are what the caller aims a disconnect at. They are the scope
// of the revoke and nothing wider: this person may hold spaces in other orgs,
// which this transaction does not touch and whose sockets must survive.
//
// Per space it does exactly what mutateMembership would have done one call at
// a time: if the person is the sole owner it promotes a replacement, and if
// there is nobody to promote it refuses and nothing at all is written. The
// promotion rule is the one 0015_member_roles.sql already established for this
// problem — most recent last_seen_at, user_id as the tiebreak — and it
// excludes the person being revoked.
func (s *Store) RevokeOrgMember(ctx context.Context, scope Scope, userID string) (removed, blocked []string, err error) {
	err = s.inTx(ctx, func(tx pgx.Tx) error {
		removed, blocked = nil, nil
		current, admins, err := lockOrgMembership(ctx, tx, scope.OrgID, userID)
		// Somebody with no membership row is still revocable: the tombstone is
		// an upsert precisely so an admin can shut the door before the person
		// has ever been through it.
		if err != nil && !errors.Is(err, ErrNotAMember) {
			return err
		}
		if current == orgRoleAdmin && admins < 2 {
			return ErrLastAdmin
		}

		rows, err := tx.Query(ctx, `
			select sp.id, sp.slug, m.role,
			       (select count(*) from members o where o.space_id = sp.id and o.role = 'owner')
			from members m join spaces sp on sp.id = m.space_id
			where sp.org_id = $1 and m.user_id = $2
			order by sp.slug
			for update of m`, scope.OrgID, userID)
		if err != nil {
			return fmt.Errorf("reading the member's spaces: %w", err)
		}
		type spaceRow struct {
			id, slug, role string
			owners         int
		}
		var spaces []spaceRow
		for rows.Next() {
			var sr spaceRow
			if err := rows.Scan(&sr.id, &sr.slug, &sr.role, &sr.owners); err != nil {
				rows.Close()
				return fmt.Errorf("reading the member's spaces: %w", err)
			}
			spaces = append(spaces, sr)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return fmt.Errorf("reading the member's spaces: %w", err)
		}

		var needPromotion []string
		needsOne := map[string]bool{}
		for _, sr := range spaces {
			// A space that already has a second owner needs no promotion at
			// all: the grant is additive, so promoting anyway would quietly
			// hand ownership to somebody nobody chose.
			if sr.role != roleOwner || sr.owners > 1 {
				continue
			}
			needPromotion = append(needPromotion, sr.id)
			needsOne[sr.id] = true
		}
		promoted, err := promoteSuccessors(ctx, tx, needPromotion, userID)
		if err != nil {
			return err
		}
		// A space that needed a successor and did not get one has nobody left
		// to promote, and blocks the whole revoke. `spaces` is ordered by slug,
		// so the refusal names them in a stable order.
		for _, sr := range spaces {
			if needsOne[sr.id] && !promoted[sr.id] {
				blocked = append(blocked, sr.slug)
			}
		}
		if len(blocked) > 0 {
			return ErrWouldStrandSpace
		}
		for _, sr := range spaces {
			removed = append(removed, sr.id)
		}

		if _, err := tx.Exec(ctx, `
			delete from members m using spaces sp
			where sp.id = m.space_id and sp.org_id = $1 and m.user_id = $2`, scope.OrgID, userID); err != nil {
			return fmt.Errorf("removing the member's spaces: %w", err)
		}
		// Same reason a space-level RemoveMember prunes these: the person can
		// never cast again, and open-voting completion trusts round_voters
		// without re-deriving membership on every vote. Leaving them in
		// session_participants would also resurrect them on the next snapshot.
		if _, err := tx.Exec(ctx, `
			delete from round_voters rv
			using stories st
			join sessions s on s.id = st.session_id
			join spaces sp on sp.id = s.space_id
			where rv.story_id = st.id and rv.user_id = $1 and sp.org_id = $2`,
			userID, scope.OrgID); err != nil {
			return fmt.Errorf("dropping the member from open rounds: %w", err)
		}
		if _, err := tx.Exec(ctx, `
			delete from session_participants sp
			using sessions s
			join spaces spc on spc.id = s.space_id
			where sp.session_id = s.id and sp.user_id = $1 and spc.org_id = $2`,
			userID, scope.OrgID); err != nil {
			return fmt.Errorf("dropping the member from session rosters: %w", err)
		}
		// An upsert rather than an update: an admin may revoke somebody with
		// no org_members row yet, where an update would affect zero rows and
		// the next sign-in would insert a clean one.
		if _, err := tx.Exec(ctx, `
			insert into org_members (org_id, user_id, role, revoked_at)
			values ($1, $2, $3, now())
			on conflict (org_id, user_id) do update set revoked_at = now()`,
			scope.OrgID, userID, orgRoleMember); err != nil {
			return fmt.Errorf("revoking an org member: %w", err)
		}
		return nil
	})
	if err != nil {
		return nil, blocked, err
	}
	return removed, nil, nil
}

// promoteSuccessors gives every named space a new owner in one statement and
// reports which ones got one. A space missing from the result had no eligible
// member left, which is the caller's cue to refuse.
//
// The per-space rule is unchanged, only evaluated set-wise: `distinct on
// (space_id)` picks one candidate per space, and the ORDER BY carries 0015's
// rule — most recent last_seen_at, user_id as the tiebreak — with space_id
// leading it because `distinct on` requires that. The person being revoked is
// excluded, and the update touches only the rows the candidate set names, so
// a space that already has a second owner is never reached: it is not in the
// list at all.
func promoteSuccessors(ctx context.Context, tx pgx.Tx, spaceIDs []string, userID string) (map[string]bool, error) {
	promoted := map[string]bool{}
	if len(spaceIDs) == 0 {
		return promoted, nil
	}
	rows, err := tx.Query(ctx, `
		with candidates as (
			select distinct on (m.space_id) m.space_id, m.user_id
			from members m
			where m.space_id = any($1::uuid[]) and m.user_id <> $2
			order by m.space_id, m.last_seen_at desc, m.user_id
		)
		update members m set role = $3
		from candidates c
		where m.space_id = c.space_id and m.user_id = c.user_id
		returning m.space_id::text`, spaceIDs, userID, roleOwner)
	if err != nil {
		return nil, fmt.Errorf("promoting successor owners: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var spaceID string
		if err := rows.Scan(&spaceID); err != nil {
			return nil, fmt.Errorf("promoting successor owners: %w", err)
		}
		promoted[spaceID] = true
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("promoting successor owners: %w", err)
	}
	return promoted, nil
}

// RestoreOrgMember lifts a revocation. Only a revoked row is restorable: an
// active membership is not something to "restore", and reporting it as missing
// keeps the two states honestly apart.
func (s *Store) RestoreOrgMember(ctx context.Context, orgID, userID string) error {
	tag, err := s.Pool.Exec(ctx,
		"update org_members set revoked_at = null where org_id = $1 and user_id = $2 and revoked_at is not null",
		orgID, userID)
	if err != nil {
		return fmt.Errorf("restoring an org member: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotAMember
	}
	return nil
}

// Counts is what a purge destroys.
type Counts struct {
	Spaces   int `json:"spaces"`
	Sessions int `json:"sessions"`
}

// Purge deletes an org and everything in it, in one transaction.
//
// A purge reports what it destroyed, not what it expected to destroy: the
// numbers come back from the delete itself, so a space committed by somebody
// else while the purge was running is counted rather than quietly vaporised.
// The counts read before the confirmation is checked are a preview and are
// reported only on the refusal path, where nothing has been destroyed at all.
//
// An interrupted purge is a rolled-back transaction and leaves the org and
// every space exactly as they were — which matters more here than anywhere
// else in the codebase, because spaces.org_id is `on delete restrict`: a
// half-finished purge would otherwise leave some spaces gone, the rest
// standing, and the org row undeletable, with no described way back.
func (s *Store) Purge(ctx context.Context, scope Scope, confirm string) (Counts, error) {
	var counts Counts
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return counts, fmt.Errorf("beginning an org purge: %w", err)
	}
	defer tx.Rollback(ctx)

	counts, err = countOrgContents(ctx, tx, scope.OrgID)
	if err != nil {
		return counts, err
	}
	if confirm != scope.OrgSlug {
		return counts, ErrConfirmationRequired
	}
	if s.hooks.afterCount != nil {
		if err := s.hooks.afterCount(ctx); err != nil {
			return counts, err
		}
	}
	counts, err = purgeTx(ctx, tx, scope, s.hooks.beforeOrgDelete)
	if err != nil {
		return counts, err
	}
	if err := tx.Commit(ctx); err != nil {
		return counts, fmt.Errorf("committing an org purge: %w", err)
	}
	return counts, nil
}

// countOrgContents is the preview a refused purge reports. It is deliberately
// not the number a completed purge reports: under read committed another
// session can commit a space between this select and the delete, and that
// space would be destroyed without ever appearing here.
func countOrgContents(ctx context.Context, tx pgx.Tx, orgID string) (Counts, error) {
	var c Counts
	if err := tx.QueryRow(ctx, `
		select (select count(*) from spaces where org_id = $1),
		       (select count(*) from sessions se join spaces sp on sp.id = se.space_id where sp.org_id = $1)`,
		orgID).Scan(&c.Spaces, &c.Sessions); err != nil {
		return c, fmt.Errorf("counting an org's contents: %w", err)
	}
	return c, nil
}

// purgeTx is the destructive half, separated so a test can run it inside a
// transaction it then aborts and prove that an interrupted purge leaves
// everything standing. It returns what it actually destroyed.
//
// The spaces and their sessions are counted by the same statement that deletes
// them, so the two cannot disagree: a single statement sees one snapshot, and
// the sessions counted are exactly the sessions the delete cascaded away.
// Counting beforehand and deleting afterwards would report a number that was
// already stale by the time the delete ran.
//
// Order is load-bearing exactly once: spaces.org_id is `on delete restrict`,
// so the spaces have to go before the org row. org_members needs no step of
// its own — it cascades with the org.
func purgeTx(ctx context.Context, tx pgx.Tx, scope Scope, beforeOrgDelete func(context.Context, pgx.Tx) error) (Counts, error) {
	var counts Counts
	if err := tx.QueryRow(ctx, `
		with doomed as (delete from spaces where org_id = $1 returning id)
		select (select count(*) from doomed),
		       (select count(*) from sessions where space_id in (select id from doomed))`,
		scope.OrgID).Scan(&counts.Spaces, &counts.Sessions); err != nil {
		return counts, fmt.Errorf("deleting the org's spaces: %w", err)
	}
	// Written after the spaces so it can say what there actually was, still
	// inside the same transaction and still before the org row goes, and never
	// cascaded away: this is the record of the most destructive action in the
	// product, and it has to outlive everything it names.
	if err := audit(ctx, tx, scope, SpaceRef{}, "org.purge",
		fmt.Sprintf("purged %d spaces and %d sessions", counts.Spaces, counts.Sessions)); err != nil {
		return counts, err
	}
	if beforeOrgDelete != nil {
		if err := beforeOrgDelete(ctx, tx); err != nil {
			return counts, err
		}
	}
	tag, err := tx.Exec(ctx, "delete from orgs where id = $1", scope.OrgID)
	if err != nil {
		return counts, fmt.Errorf("deleting the org: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return counts, fmt.Errorf("deleting the org: it was already gone")
	}
	return counts, nil
}

// audit writes one record. The org and space slugs are stored as text
// alongside the ids because both foreign keys are `on delete set null`: a
// purge nulls the ids, and a record that could no longer say what it happened
// to would be no record at all.
func audit(ctx context.Context, tx pgx.Tx, scope Scope, sp SpaceRef, action, detail string) error {
	var spaceID, actorID *string
	if sp.ID != "" {
		spaceID = &sp.ID
	}
	// Nullable, so a record can still be written for something the system did
	// with no signed-in actor behind it. The column is `on delete set null`
	// anyway: history is not rewritten when an account goes away.
	if scope.ActorID != "" {
		actorID = &scope.ActorID
	}
	if _, err := tx.Exec(ctx, `
		insert into org_audit_log (org_id, org_slug, space_id, space_slug, actor_id, action, detail)
		values ($1, $2, $3, $4, $5, $6, $7)`,
		scope.OrgID, scope.OrgSlug, spaceID, sp.Slug, actorID, action, detail); err != nil {
		return fmt.Errorf("writing an audit record: %w", err)
	}
	return nil
}

func (s *Store) inTx(ctx context.Context, fn func(pgx.Tx) error) error {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("beginning a custody change: %w", err)
	}
	defer tx.Rollback(ctx)
	if err := fn(tx); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("committing a custody change: %w", err)
	}
	return nil
}

// RecordPluginAction writes the audit record for an action a plugin panel
// proposed and the user's own session performed.
//
// It is exported because the plugin bridge lives in the api package. This is
// no longer the only writer of org_audit_log: internal/api/plugins.go writes
// its own row for the operator-facing plugin audit trail (auditPlugin,
// auditPluginTx), with a different column shape (no space_id/space_slug) from
// the insert below. A reader of org_audit_log has to handle both shapes.
//
// The action is stored as "plugin.action" with the plugin's name first in the
// detail, so the plugin is the route the record names — the actor stays the
// user, because the user is who it was done as.
func RecordPluginAction(ctx context.Context, pool *pgxpool.Pool, scope Scope, plugin, detail string) error {
	s := &Store{Pool: pool}
	return s.inTx(ctx, func(tx pgx.Tx) error {
		return audit(ctx, tx, scope, SpaceRef{}, "plugin.action", plugin+" "+detail)
	})
}
