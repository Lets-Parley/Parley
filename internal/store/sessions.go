package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrNoSession      = errors.New("no such session")
	ErrNotEligible    = errors.New("not eligible")
	ErrNotFacilitator = errors.New("not facilitator")
	ErrSessionEnded   = errors.New("session ended")
)

// FacilitatorGrace is how long a facilitator must be unseen before any member
// may claim the role.
const FacilitatorGrace = 60 * time.Second

type Session struct {
	ID                string     `json:"id"`
	SpaceID           string     `json:"spaceId"`
	Kind              string     `json:"kind"`
	Title             string     `json:"title"`
	Config            []byte     `json:"-"`
	Phase             string     `json:"phase"`
	Revealed          bool       `json:"revealed"`
	Version           int64      `json:"version"`
	FacilitatorID     string     `json:"facilitatorId"`
	FacilitatorSeenAt time.Time  `json:"-"`
	CreatedAt         time.Time  `json:"createdAt"`
	EndedAt           *time.Time `json:"endedAt"`
}

type Sessions struct {
	Pool *pgxpool.Pool
}

const sessionCols = "id, space_id, kind, title, config, phase, revealed, version, facilitator_id, facilitator_seen_at, created_at, ended_at"

func scanSession(row pgx.Row) (Session, error) {
	var s Session
	err := row.Scan(&s.ID, &s.SpaceID, &s.Kind, &s.Title, &s.Config, &s.Phase,
		&s.Revealed, &s.Version, &s.FacilitatorID, &s.FacilitatorSeenAt, &s.CreatedAt, &s.EndedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Session{}, ErrNoSession
	}
	return s, err
}

func (s *Sessions) Create(ctx context.Context, spaceID, kind, title string, config []byte, facilitatorID string, limit int) (Session, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return Session{}, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, "select id from spaces where id = $1 for update", spaceID); err != nil {
		return Session{}, err
	}
	var count int
	if err := tx.QueryRow(ctx, "select count(*) from sessions where space_id = $1", spaceID).Scan(&count); err != nil {
		return Session{}, err
	}
	if count >= limit {
		return Session{}, ErrQuotaExceeded
	}
	sess, err := scanSession(tx.QueryRow(ctx,
		"insert into sessions (space_id, kind, title, config, facilitator_id) values ($1, $2, $3, $4, $5) returning "+sessionCols,
		spaceID, kind, title, config, facilitatorID))
	if err != nil {
		return Session{}, err
	}
	return sess, tx.Commit(ctx)
}

// KindRetired reports whether the kind's row carries a retired_at. A retired
// kind keeps its row — the foreign key is RESTRICT and existing sessions still
// have to resolve — so nothing stops a new session using it but this check.
func (s *Sessions) KindRetired(ctx context.Context, kind string) (bool, error) {
	var retired bool
	err := s.Pool.QueryRow(ctx,
		"select retired_at is not null from session_kinds where kind = $1", kind).Scan(&retired)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return retired, err
}

func (s *Sessions) ByID(ctx context.Context, id string) (Session, error) {
	return scanSession(s.Pool.QueryRow(ctx, "select "+sessionCols+" from sessions where id = $1", id))
}

func (s *Sessions) ListBySpace(ctx context.Context, spaceID string) ([]Session, error) {
	rows, err := s.Pool.Query(ctx,
		"select "+sessionCols+" from sessions where space_id = $1 order by created_at desc limit 50", spaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Session{}
	for rows.Next() {
		sess, err := scanSession(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, sess)
	}
	return out, rows.Err()
}

func (s *Sessions) withLockedSession(ctx context.Context, id, actorID string, activeOnly bool, fn func(pgx.Tx, Session) error) error {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	sess, err := scanSession(tx.QueryRow(ctx,
		"select "+sessionCols+" from sessions where id = $1 for update", id))
	if err != nil {
		return err
	}
	if sess.FacilitatorID != actorID {
		return ErrNotFacilitator
	}
	if activeOnly && sess.EndedAt != nil {
		return ErrSessionEnded
	}
	if err := fn(tx, sess); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// WithActiveSession locks the session row, revalidates current facilitator
// authority when required, and commits fn in the same transaction. Authority
// is checked before closure so callers can distinguish 403 from 409.
func (s *Sessions) WithActiveSession(ctx context.Context, id, actorID string, facilitatorOnly bool, fn func(pgx.Tx, Session) error) error {
	if facilitatorOnly {
		return s.withLockedSession(ctx, id, actorID, true, fn)
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	sess, err := scanSession(tx.QueryRow(ctx,
		"select "+sessionCols+" from sessions where id = $1 for update", id))
	if err != nil {
		return err
	}
	if sess.EndedAt != nil {
		return ErrSessionEnded
	}
	if err := fn(tx, sess); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Sessions) SetEnded(ctx context.Context, id, actorID string, ended bool) error {
	return s.withLockedSession(ctx, id, actorID, false, func(tx pgx.Tx, _ Session) error {
		// The ended_at predicate is what makes this idempotent: a retried or
		// double-clicked DELETE must not move the recorded end time forward,
		// bump the version, or broadcast a second time. Under the row lock, so
		// two concurrent closes cannot both see it as open.
		var q string
		if ended {
			q = "update sessions set ended_at = now(), version = version + 1 where id = $1 and ended_at is null"
		} else {
			q = "update sessions set ended_at = null, version = version + 1 where id = $1 and ended_at is not null"
		}
		_, err := tx.Exec(ctx, q, id)
		return err
	})
}

func (s *Sessions) TransferFacilitator(ctx context.Context, id, actorID, toUserID string) error {
	return s.withLockedSession(ctx, id, actorID, false, func(tx pgx.Tx, sess Session) error {
		if toUserID == sess.FacilitatorID {
			return nil
		}
		var member bool
		if err := tx.QueryRow(ctx,
			"select exists (select 1 from members where space_id = $1 and user_id = $2)",
			sess.SpaceID, toUserID).Scan(&member); err != nil {
			return err
		}
		if !member {
			return ErrNotEligible
		}
		_, err := tx.Exec(ctx, `
			update sessions set facilitator_id = $2, facilitator_seen_at = now(), version = version + 1
			where id = $1`, id, toUserID)
		return err
	})
}

// ClaimFacilitator succeeds only when the current facilitator has not been seen
// within the grace period. The conditional UPDATE serializes concurrent claims:
// exactly one wins.
func (s *Sessions) ClaimFacilitator(ctx context.Context, id, claimerID string) error {
	tag, err := s.Pool.Exec(ctx, `
		update sessions set facilitator_id = $2, facilitator_seen_at = now(), version = version + 1
		where id = $1 and facilitator_id <> $2 and facilitator_seen_at < now() - $3::interval`,
		id, claimerID, FacilitatorGrace)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotEligible
	}
	return nil
}

// TouchFacilitatorSeen records liveness; called on WS connect and every pong
// from the facilitator's connection.
func (s *Sessions) TouchFacilitatorSeen(ctx context.Context, id, userID string) error {
	_, err := s.Pool.Exec(ctx,
		"update sessions set facilitator_seen_at = now() where id = $1 and facilitator_id = $2",
		id, userID)
	return err
}

func (s *Sessions) BumpVersion(ctx context.Context, id string) error {
	_, err := s.Pool.Exec(ctx, "update sessions set version = version + 1 where id = $1", id)
	return err
}
