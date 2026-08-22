package store

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"

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
	slugStrip        = regexp.MustCompile(`[^a-z0-9]+`)
	slugTrim         = regexp.MustCompile(`^-+|-+$`)
)

type Space struct {
	ID   string `json:"id"`
	Slug string `json:"slug"`
	Name string `json:"name"`
	// Passcode is what a non-member must present to join. Empty means
	// the space is open to anyone with the link. Never serialize this to a
	// non-member: handlers pick what to expose.
	Passcode string `json:"-"`
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

func (s *Spaces) Create(ctx context.Context, name, slug, passcode, creatorID string, limit int) (Space, error) {
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
		"insert into spaces (slug, name, passcode, creator_id) values ($1, $2, $3, $4) returning id, slug, name, passcode",
		slug, name, passcode, creatorID,
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

func (s *Spaces) BySlug(ctx context.Context, slug string) (Space, error) {
	var sp Space
	err := s.Pool.QueryRow(ctx,
		"select id, slug, name, passcode from spaces where slug = $1", slug,
	).Scan(&sp.ID, &sp.Slug, &sp.Name, &sp.Passcode)
	if errors.Is(err, pgx.ErrNoRows) {
		return Space{}, ErrNoSpace
	}
	return sp, err
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
	Slug      string `json:"slug"`
	Name      string `json:"name"`
	Protected bool   `json:"protected"`
}

// ForUser lists the caller's own spaces, most recently active first.
func (s *Spaces) ForUser(ctx context.Context, userID string) ([]Membership, error) {
	rows, err := s.Pool.Query(ctx, `
		select sp.slug, sp.name, sp.passcode <> ''
		from members m join spaces sp on sp.id = m.space_id
		where m.user_id = $1
		order by m.last_seen_at desc, sp.name`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	spaces := []Membership{}
	for rows.Next() {
		var sp Membership
		if err := rows.Scan(&sp.Slug, &sp.Name, &sp.Protected); err != nil {
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
