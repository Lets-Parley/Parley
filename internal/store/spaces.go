package store

import (
	"context"
	"errors"
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
	slugStrip        = regexp.MustCompile(`[^a-z0-9]+`)
	slugTrim         = regexp.MustCompile(`^-+|-+$`)
)

type Space struct {
	ID   string `json:"id"`
	Slug string `json:"slug"`
	Name string `json:"name"`
	// Passcode is the room code a non-member must present to join. Empty means
	// the space is open to anyone with the link. Never serialize this to a
	// non-member: handlers pick what to expose.
	Passcode string `json:"-"`
}

type Member struct {
	UserID    string `json:"userId"`
	Name      string `json:"name"`
	Spectator bool   `json:"spectator"`
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
	if _, err := tx.Exec(ctx, "insert into members (space_id, user_id) values ($1, $2)", sp.ID, creatorID); err != nil {
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

// SetPasscode replaces the room code, or clears it to open the space.
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

func (s *Spaces) Roster(ctx context.Context, spaceID string) ([]Member, error) {
	rows, err := s.Pool.Query(ctx, `
		select m.user_id, u.name, m.spectator
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
		if err := rows.Scan(&m.UserID, &m.Name, &m.Spectator); err != nil {
			return nil, err
		}
		members = append(members, m)
	}
	return members, rows.Err()
}
