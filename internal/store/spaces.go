package store

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrSlugTaken     = errors.New("slug taken")
	ErrNoSpace       = errors.New("no such space")
	ErrQuotaExceeded = errors.New("resource quota exceeded")
	ErrNotMember     = errors.New("not a member of this space")
	ErrBadRole       = errors.New("unknown role")
	ErrLastOwner     = errors.New("the last owner cannot be demoted or removed")
	ErrBadVisibility = errors.New("unknown visibility")
	slugStrip        = regexp.MustCompile(`[^a-z0-9]+`)
	slugTrim         = regexp.MustCompile(`^-+|-+$`)
)

// Space visibility. 'private' is reachable only by its link or an invitation;
// 'org' is additionally listed to the org's members. The same two values are
// the spaces.visibility CHECK constraint.
//
// The column defaults to 'private' so an upgrade discloses exactly what it
// disclosed the day before. New spaces name their visibility explicitly.
const (
	VisibilityPrivate = "private"
	VisibilityOrg     = "org"
)

type Space struct {
	ID   string `json:"id"`
	Slug string `json:"slug"`
	Name string `json:"name"`
	// Passcode is what a non-member must present to join. Empty means
	// the space is open to anyone with the link. Never serialize this to a
	// non-member: handlers pick what to expose.
	Passcode string `json:"-"`
	// Visibility is VisibilityPrivate or VisibilityOrg. Withheld from the
	// wire for the same reason as the passcode: whether a space is listed to
	// its org is the room's business, and the anonymous pre-join view must not
	// gain a field just because this struct did. Handlers pick what to expose.
	Visibility string `json:"-"`
}

// Space roles. An owner may promote, demote and remove; a member may not.
// The same two values are the members.role CHECK constraint.
const (
	RoleOwner  = "owner"
	RoleMember = "member"
)

type Member struct {
	UserID    string `json:"userId"`
	Name      string `json:"name"`
	Spectator bool   `json:"spectator"`
	// Role is RoleOwner or RoleMember. It is safe to show every member: it
	// says who can manage the room, which everyone in the room needs to know.
	Role string `json:"role"`
	// The chosen avatar, so a roster renders the same person the same way the
	// session envelope does.
	AvatarIcon string `json:"avatarIcon"`
}

type Spaces struct {
	Pool *pgxpool.Pool
}

// Slugify turns a display name into a URL slug: "Platform Team" -> "platform-team".
func Slugify(name string) string {
	s := strings.ToLower(strings.TrimSpace(name))
	s = slugStrip.ReplaceAllString(s, "-")
	s = slugTrim.ReplaceAllString(s, "")
	if len(s) > 64 {
		s = strings.Trim(s[:64], "-")
	}
	return s
}

// Create makes a space inside one org. visibility is passed in rather than
// defaulted here because open mode must force VisibilityPrivate: it mints
// anonymous identities, and an org-visible space with no passcode would let
// any visitor walk into any new room.
func (s *Spaces) Create(ctx context.Context, orgID, name, slug, passcode, creatorID, visibility string, limit int) (Space, error) {
	if visibility != VisibilityPrivate && visibility != VisibilityOrg {
		return Space{}, ErrBadVisibility
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return Space{}, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, "select id from users where id = $1 for update", creatorID); err != nil {
		return Space{}, err
	}
	var count int
	if err := tx.QueryRow(ctx, "select count(*) from spaces where creator_id = $1", creatorID).Scan(&count); err != nil {
		return Space{}, err
	}
	if count >= limit {
		return Space{}, ErrQuotaExceeded
	}
	var sp Space
	err = tx.QueryRow(ctx,
		"insert into spaces (org_id, slug, name, passcode, creator_id, visibility) values ($1, $2, $3, $4, $5, $6) returning id, slug, name, passcode",
		orgID, slug, name, passcode, creatorID, visibility,
	).Scan(&sp.ID, &sp.Slug, &sp.Name, &sp.Passcode)
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		return Space{}, ErrSlugTaken
	}
	if err != nil {
		return Space{}, err
	}
	if _, err := tx.Exec(ctx, "insert into members (space_id, user_id, role) values ($1, $2, $3)", sp.ID, creatorID, RoleOwner); err != nil {
		return Space{}, err
	}
	return sp, tx.Commit(ctx)
}

// BySlug resolves a slug within one org. A slug is unique inside an org, not
// across the instance, so the org is part of the question.
func (s *Spaces) BySlug(ctx context.Context, orgID, slug string) (Space, error) {
	var sp Space
	err := s.Pool.QueryRow(ctx,
		"select id, slug, name, passcode, visibility from spaces where org_id = $1 and slug = $2", orgID, slug,
	).Scan(&sp.ID, &sp.Slug, &sp.Name, &sp.Passcode, &sp.Visibility)
	if errors.Is(err, pgx.ErrNoRows) {
		return Space{}, ErrNoSpace
	}
	return sp, err
}

// BySlugInOrg resolves an org slug and a space slug together, in one query.
//
// The single statement is the point, not a convenience: this is the anonymous
// link-landing lookup, so a nonexistent org, a space in a different org, and a
// slug that exists nowhere must all fail identically. Resolving the org first
// and the space second would cost one query for a bad org and two for a bad
// slug, and that difference is a cross-org existence oracle no amount of
// matching the response body hides.
func (s *Spaces) BySlugInOrg(ctx context.Context, orgSlug, slug string) (Space, error) {
	var sp Space
	err := s.Pool.QueryRow(ctx, `
		select sp.id, sp.slug, sp.name, sp.passcode, sp.visibility
		from spaces sp join orgs o on o.id = sp.org_id
		where o.slug = $1 and sp.slug = $2`, orgSlug, slug,
	).Scan(&sp.ID, &sp.Slug, &sp.Name, &sp.Passcode, &sp.Visibility)
	if errors.Is(err, pgx.ErrNoRows) {
		return Space{}, ErrNoSpace
	}
	return sp, err
}

// OrgSlugsForMemberSpaceSlug lists the slugs of the orgs the caller belongs to
// that hold a space with this slug, capped at two results.
//
// It is the legacy-link redirect's whole lookup, and the join to org_members is
// the security property rather than a filter for convenience: resolving the
// slug globally and checking membership afterwards would answer differently for
// a slug that exists in an org the caller cannot reach than for one that exists
// nowhere, which is a cross-org existence oracle. Two rows is all the caller of
// this needs — one is a redirect, anything else is not — so the scan stops
// there rather than materialising every collision on the instance.
func (s *Spaces) OrgSlugsForMemberSpaceSlug(ctx context.Context, userID, slug string) ([]string, error) {
	rows, err := s.Pool.Query(ctx, `
		select o.slug
		from spaces sp
		join orgs o on o.id = sp.org_id
		join org_members om on om.org_id = o.id and om.user_id = $1 and om.revoked_at is null
		where sp.slug = $2
		order by o.slug
		limit 2`, userID, slug)
	if err != nil {
		return nil, fmt.Errorf("resolving legacy space slug: %w", err)
	}
	defer rows.Close()
	var orgs []string
	for rows.Next() {
		var org string
		if err := rows.Scan(&org); err != nil {
			return nil, fmt.Errorf("resolving legacy space slug: %w", err)
		}
		orgs = append(orgs, org)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("resolving legacy space slug: %w", err)
	}
	return orgs, nil
}

// SetPasscode replaces the passcode, or clears it to open the space.
func (s *Spaces) SetPasscode(ctx context.Context, spaceID, passcode string) error {
	_, err := s.Pool.Exec(ctx, "update spaces set passcode = $2 where id = $1", spaceID, passcode)
	return err
}

func (s *Spaces) Join(ctx context.Context, spaceID, userID string) error {
	_, err := s.Pool.Exec(ctx, `
		insert into members (space_id, user_id) values ($1, $2)
		on conflict (space_id, user_id) do update set last_seen_at = now()`,
		spaceID, userID)
	return err
}

// IsMemberOrLinkGuest answers the hub's revalidation question — may this user
// still hold a socket on this room? — in one roundtrip. A link guest is by
// design not a member of the room's space, so both predicates have to be
// asked; asking them as two queries doubled the query volume of the
// revalidation loop for the whole connected population to serve the rare case.
func (s *Spaces) IsMemberOrLinkGuest(ctx context.Context, spaceID, sessionID, userID string) (bool, error) {
	var ok bool
	err := s.Pool.QueryRow(ctx, `
		select exists (select 1 from members where space_id = $1 and user_id = $3)
		    or exists (
			select 1 from users u join session_links l on l.id = u.link_id
			where u.id = $3 and l.session_id = $2 and l.revoked_at is null and l.expires_at > now())`,
		spaceID, sessionID, userID).Scan(&ok)
	if err != nil {
		return false, fmt.Errorf("checking room access: %w", err)
	}
	return ok, nil
}

func (s *Spaces) IsMember(ctx context.Context, spaceID, userID string) (bool, error) {
	var ok bool
	err := s.Pool.QueryRow(ctx,
		"select exists (select 1 from members where space_id = $1 and user_id = $2)",
		spaceID, userID,
	).Scan(&ok)
	return ok, err
}

// MarkSeen records that a member just opened a space, so the landing page can
// order by real use rather than by when someone joined. Joining already stamps
// the row; without this, a space you created a year ago and open daily would
// sort below one you joined yesterday and never looked at again.
//
// One targeted update on the primary key, and only for a caller already known
// to be a member — the space page is not polled, so this is one write per open.
func (s *Spaces) MarkSeen(ctx context.Context, spaceID, userID string) error {
	_, err := s.Pool.Exec(ctx,
		"update members set last_seen_at = now() where space_id = $1 and user_id = $2",
		spaceID, userID)
	return err
}

// Membership is one space the caller belongs to, as the landing page lists
// them. Deliberately no passcode: this is a list, not a space someone opened.
// last_seen_at orders the list server-side and is not part of the payload —
// nothing on the page shows it.
type Membership struct {
	Slug string `json:"slug"`
	Name string `json:"name"`
	// OrgSlug is the org segment of the space's URL. Slugs are unique inside
	// an org rather than across the instance, so a list entry without it
	// cannot be turned back into a link.
	OrgSlug   string `json:"orgSlug"`
	Protected bool   `json:"protected"`
}

// ForUser lists the caller's own spaces, most recently active first.
func (s *Spaces) ForUser(ctx context.Context, userID string) ([]Membership, error) {
	rows, err := s.Pool.Query(ctx, `
		select sp.slug, sp.name, o.slug, sp.passcode <> ''
		from members m
		join spaces sp on sp.id = m.space_id
		join orgs o on o.id = sp.org_id
		where m.user_id = $1
		order by m.last_seen_at desc, sp.name`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	spaces := []Membership{}
	for rows.Next() {
		var sp Membership
		if err := rows.Scan(&sp.Slug, &sp.Name, &sp.OrgSlug, &sp.Protected); err != nil {
			return nil, err
		}
		spaces = append(spaces, sp)
	}
	return spaces, rows.Err()
}

func (s *Spaces) Roster(ctx context.Context, spaceID string) ([]Member, error) {
	rows, err := s.Pool.Query(ctx, `
		select m.user_id, u.name, m.spectator, m.role, u.avatar_icon
		from members m join users u on u.id = m.user_id
		where m.space_id = $1
		order by u.name`, spaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	members := []Member{}
	for rows.Next() {
		var m Member
		if err := rows.Scan(&m.UserID, &m.Name, &m.Spectator, &m.Role, &m.AvatarIcon); err != nil {
			return nil, err
		}
		members = append(members, m)
	}
	return members, rows.Err()
}

// RoleOf reports the caller's standing in a space. A non-member is
// ErrNotMember rather than an empty role, so no caller can mistake "not here"
// for "here without privileges".
func (s *Spaces) RoleOf(ctx context.Context, spaceID, userID string) (string, error) {
	var role string
	err := s.Pool.QueryRow(ctx,
		"select role from members where space_id = $1 and user_id = $2", spaceID, userID,
	).Scan(&role)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNotMember
	}
	if err != nil {
		return "", fmt.Errorf("reading member role: %w", err)
	}
	return role, nil
}

// SetRole promotes or demotes a member. It refuses to demote the last owner:
// a space with nobody who can manage it can never be recovered, and that is
// true whether the demotion is aimed at someone else or at oneself.
func (s *Spaces) SetRole(ctx context.Context, spaceID, userID, role string) error {
	if role != RoleOwner && role != RoleMember {
		return ErrBadRole
	}
	return s.mutateMembership(ctx, spaceID, userID, func(tx pgx.Tx, current string, owners int) error {
		if current == RoleOwner && role != RoleOwner && owners < 2 {
			return ErrLastOwner
		}
		if current == role {
			return nil
		}
		_, err := tx.Exec(ctx, "update members set role = $3 where space_id = $1 and user_id = $2", spaceID, userID, role)
		if err != nil {
			return fmt.Errorf("updating member role: %w", err)
		}
		return nil
	})
}

// RemoveMember revokes membership. Access is checked against this table on
// every request, so the removal takes effect on the member's next one.
func (s *Spaces) RemoveMember(ctx context.Context, spaceID, userID string) error {
	return s.mutateMembership(ctx, spaceID, userID, func(tx pgx.Tx, current string, owners int) error {
		if current == RoleOwner && owners < 2 {
			return ErrLastOwner
		}
		_, err := tx.Exec(ctx, "delete from members where space_id = $1 and user_id = $2", spaceID, userID)
		if err != nil {
			return fmt.Errorf("removing member: %w", err)
		}
		return nil
	})
}

// mutateMembership runs fn against a locked view of the space's membership,
// handing it the target's current role and the space's owner count. The lock
// is what makes the last-owner guard real: two owners demoting each other at
// the same instant would otherwise each see the other and both succeed.
func (s *Spaces) mutateMembership(ctx context.Context, spaceID, userID string, fn func(pgx.Tx, string, int) error) error {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("beginning membership change: %w", err)
	}
	defer tx.Rollback(ctx)

	var current string
	var owners int
	// One locking pass over the space's rows: the count and the target's role
	// are read from the same snapshot nobody else can move underneath us.
	rows, err := tx.Query(ctx, "select user_id, role from members where space_id = $1 order by user_id for update", spaceID)
	if err != nil {
		return fmt.Errorf("locking space membership: %w", err)
	}
	found := false
	for rows.Next() {
		var id, role string
		if err := rows.Scan(&id, &role); err != nil {
			rows.Close()
			return fmt.Errorf("reading space membership: %w", err)
		}
		if role == RoleOwner {
			owners++
		}
		if id == userID {
			current, found = role, true
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return fmt.Errorf("reading space membership: %w", err)
	}
	if !found {
		return ErrNotMember
	}
	if err := fn(tx, current, owners); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// Rename changes the display name. The slug is deliberately left alone: it is
// in every invite link anyone has already pasted into a chat, and a rename is
// not a good enough reason to break those. So the URL keeps the original name
// and the page shows the new one.
func (s *Spaces) Rename(ctx context.Context, spaceID, name string) error {
	tag, err := s.Pool.Exec(ctx, "update spaces set name = $2 where id = $1", spaceID, name)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNoSpace
	}
	return nil
}

// Delete removes a space and everything under it. Sessions, stories, standup
// rows, presence and memberships all hang off it with `on delete cascade`, so
// this one statement is the whole teardown — there is no order to get wrong
// and no second pass that can be interrupted halfway.
//
// It is genuinely irreversible: there is no deleted_at to undo, because a
// soft-deleted space still holds the slug and would have to be reasoned about
// by every query that resolves one.
func (s *Spaces) Delete(ctx context.Context, spaceID string) error {
	tag, err := s.Pool.Exec(ctx, "delete from spaces where id = $1", spaceID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNoSpace
	}
	return nil
}

// InviteHandleLifetime bounds an invite handle. It covers one sign-in round
// trip, which takes seconds — anything longer is a live capability on a space
// sitting in a browser for no reason.
const InviteHandleLifetime = 5 * time.Minute

// CreateInviteHandle records a minted handle against one space. Only the
// digest is stored, the same way session_links stores a link token: the handle
// itself exists in exactly one HTTP response and nowhere else.
func (s *Spaces) CreateInviteHandle(ctx context.Context, spaceID string, tokenHash []byte, expiresAt time.Time) error {
	if _, err := s.Pool.Exec(ctx,
		"insert into space_invite_handles (token_hash, space_id, expires_at) values ($1, $2, $3)",
		tokenHash, spaceID, expiresAt); err != nil {
		return fmt.Errorf("creating an invite handle: %w", err)
	}
	// Opportunistic sweep of handles nobody came back for. A spent one is
	// already gone — redemption deletes it — so this only ever removes rows
	// that could no longer be redeemed anyway.
	s.Pool.Exec(ctx, "delete from space_invite_handles where expires_at <= now()")
	return nil
}

// RedeemInviteHandle spends a handle against one space, reporting whether it
// was good for that space.
//
// The delete is the whole check, deliberately: reading the row and marking it
// afterwards would let two concurrent redemptions both see it unspent and both
// be admitted. Here the second request blocks on the row lock, re-reads the
// committed row, finds it gone and matches nothing. The space id is part of
// the WHERE rather than something the caller compares afterwards, so a handle
// for one space can never be spent against another — including a same-named
// space in a different org, since a slug is unique only inside one.
func (s *Spaces) RedeemInviteHandle(ctx context.Context, spaceID string, tokenHash []byte) (bool, error) {
	tag, err := s.Pool.Exec(ctx,
		"delete from space_invite_handles where token_hash = $1 and space_id = $2 and expires_at > now()",
		tokenHash, spaceID)
	if err != nil {
		return false, fmt.Errorf("redeeming an invite handle: %w", err)
	}
	return tag.RowsAffected() == 1, nil
}

// SetVisibility moves a space between 'private' and 'org'. It deliberately
// touches nothing else — the passcode above all — because org visibility
// governs discovery and never entry: "listed in the directory but still behind
// its passcode" has to be a state a space can be in, and neither this nor
// SetPasscode may silently strip the other.
func (s *Spaces) SetVisibility(ctx context.Context, spaceID, visibility string) error {
	if visibility != VisibilityPrivate && visibility != VisibilityOrg {
		return ErrBadVisibility
	}
	tag, err := s.Pool.Exec(ctx, "update spaces set visibility = $2 where id = $1", spaceID, visibility)
	if err != nil {
		return fmt.Errorf("updating space visibility: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNoSpace
	}
	return nil
}

// OrgSpace is one row of an org's directory. Deliberately no passcode: this is
// a list of doors, not a space someone has been admitted to. Protected says
// whether the door needs a code, which is what the page needs to know whether
// to offer "Join" or "Enter the passcode"; Member says the caller is already
// inside.
type OrgSpace struct {
	Slug string `json:"slug"`
	Name string `json:"name"`
	// Visibility is VisibilityOrg or VisibilityPrivate. A private row can only
	// be one the caller belongs to — that is what the query below guarantees.
	Visibility string `json:"visibility"`
	Protected  bool   `json:"protected"`
	Member     bool   `json:"member"`
}

// ForOrg lists what one caller may see of one org: every org-visible space,
// plus every space they are a member of, private ones included. An archived
// space is in neither half — that is what archiving is for, and it is the only
// thing the flag does: the space, its members and its history are untouched
// and it is still reachable by its own URL.
//
// The membership half is a member check and not an authorship one on purpose.
// Somebody added to a private space has to keep finding it here after the
// person who created it has left, and the creator who was later removed must
// stop seeing it — creator_id answers neither question.
//
// The org id comes from requireOrgMember rather than from the URL, and the
// membership join carries the caller's own id, so no row here can name a space
// in an org the caller is outside or a private space they are not in.
func (s *Spaces) ForOrg(ctx context.Context, orgID, userID string) ([]OrgSpace, error) {
	rows, err := s.Pool.Query(ctx, `
		select sp.slug, sp.name, sp.visibility, sp.passcode <> '', m.user_id is not null
		from spaces sp
		left join members m on m.space_id = sp.id and m.user_id = $2
		where sp.org_id = $1 and sp.archived_at is null
		  and (sp.visibility = $3 or m.user_id is not null)
		order by sp.name`, orgID, userID, VisibilityOrg)
	if err != nil {
		return nil, fmt.Errorf("listing the org directory: %w", err)
	}
	defer rows.Close()
	spaces := []OrgSpace{}
	for rows.Next() {
		var sp OrgSpace
		if err := rows.Scan(&sp.Slug, &sp.Name, &sp.Visibility, &sp.Protected, &sp.Member); err != nil {
			return nil, fmt.Errorf("listing the org directory: %w", err)
		}
		spaces = append(spaces, sp)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("listing the org directory: %w", err)
	}
	return spaces, nil
}
